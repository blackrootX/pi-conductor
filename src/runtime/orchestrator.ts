// src/runtime/orchestrator.ts - Main orchestration entry point

import type { AgentRegistry } from "../registry";
import type {
  WorkflowSpec,
  WorkflowRunResult,
  ResolvedWorkflow,
  StepResultEnvelope,
} from "../workflow/types";
import type { SessionRunner } from "./childSessionRunner";
import { resolveWorkflow, formatResolutionErrors } from "../workflow/resolver";
import { createScheduler } from "./scheduler";
import { createSynthesizer } from "./synthesizer";

export interface OrchestratorOptions {
  /** Registry for agent resolution */
  registry: AgentRegistry;
  /** Session runner for executing steps */
  runner: SessionRunner;
  /** Callback for progress updates */
  onProgress?: OrchestratorProgressCallback;
}

export interface OrchestratorProgressCallback {
  (event: ProgressEvent): void;
}

export type ProgressEvent =
  | { type: "workflow:start"; workflowId: string; workflowName: string }
  | { type: "workflow:resolve"; steps: ResolvedWorkflow["steps"] }
  | { type: "workflow:resolve-error"; errors: string }
  | { type: "step:start"; stepId: string; stepTitle: string; agentName: string }
  | { type: "step:complete"; stepId: string; status: "completed" | "failed"; summary: string }
  | { type: "workflow:complete"; result: WorkflowRunResult }
  | { type: "workflow:error"; error: string };

/**
 * Orchestrator that coordinates workflow execution.
 */
export class WorkflowOrchestrator {
  private registry: AgentRegistry;
  private runner: SessionRunner;
  private onProgress?: OrchestratorProgressCallback;

  constructor(options: OrchestratorOptions) {
    this.registry = options.registry;
    this.runner = options.runner;
    this.onProgress = options.onProgress;
  }

  /**
   * Execute a workflow.
   */
  async execute(
    workflow: WorkflowSpec,
    userTask: string
  ): Promise<WorkflowRunResult> {
    const runId = generateRunId();
    const startedAt = new Date().toISOString();

    this.onProgress?.({
      type: "workflow:start",
      workflowId: workflow.id,
      workflowName: workflow.name,
    });

    // Resolve workflow
    const resolveResult = await resolveWorkflow(workflow, this.registry);

    if (!resolveResult.success || !resolveResult.resolved) {
      const errorMsg = formatResolutionErrors(resolveResult.errors);
      this.onProgress?.({
        type: "workflow:resolve-error",
        errors: errorMsg,
      });

      return {
        runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        summary: "Workflow resolution failed",
        finalText: "",
        stepResults: {},
        startedAt,
        finishedAt: new Date().toISOString(),
        status: "failed",
        error: errorMsg,
      };
    }

    const resolved = resolveResult.resolved;

    this.onProgress?.({
      type: "workflow:resolve",
      steps: resolved.steps,
    });

    // Execute workflow
    const scheduler = createScheduler(
      resolved,
      this.runner,
      userTask,
      {
        onStepStart: (step) => {
          this.onProgress?.({
            type: "step:start",
            stepId: step.id,
            stepTitle: step.title,
            agentName: step.agent.name,
          });
        },
        onStepComplete: (stepId, result) => {
          this.onProgress?.({
            type: "step:complete",
            stepId,
            status: "completed",
            summary: result.summary,
          });
        },
        onStepFail: (stepId, error) => {
          this.onProgress?.({
            type: "step:complete",
            stepId,
            status: "failed",
            summary: error,
          });
        },
      }
    );

    const schedulerResult = await scheduler.execute();

    // Synthesize results
    const synthesizer = createSynthesizer();
    const synthesis = synthesizer.synthesize(resolved, schedulerResult.results);

    // Build final result
    const finishedAt = new Date().toISOString();

    const result: WorkflowRunResult = {
      runId,
      workflowId: workflow.id,
      workflowName: workflow.name,
      summary: synthesis.summary,
      finalText: synthesis.finalText,
      stepResults: schedulerResult.results,
      startedAt,
      finishedAt,
      status: schedulerResult.success ? "completed" : "failed",
      error: schedulerResult.aborted
        ? "Workflow aborted due to step failure"
        : undefined,
    };

    this.onProgress?.({
      type: "workflow:complete",
      result,
    });

    return result;
  }

  /**
   * Execute a workflow by ID (using presets).
   */
  async executeById(
    workflowId: string,
    userTask: string,
    presets: Record<string, WorkflowSpec>
  ): Promise<WorkflowRunResult> {
    const workflow = presets[workflowId];

    if (!workflow) {
      return {
        runId: generateRunId(),
        workflowId,
        workflowName: "Unknown",
        summary: `Workflow not found: ${workflowId}`,
        finalText: "",
        stepResults: {},
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        status: "failed",
        error: `Unknown workflow: ${workflowId}`,
      };
    }

    return this.execute(workflow, userTask);
  }
}

/**
 * Create an orchestrator with default settings.
 */
export function createOrchestrator(
  registry: AgentRegistry,
  runner: SessionRunner,
  onProgress?: OrchestratorProgressCallback
): WorkflowOrchestrator {
  return new WorkflowOrchestrator({
    registry,
    runner,
    onProgress,
  });
}

/**
 * Generate a unique run ID.
 */
function generateRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Format a workflow run result for display.
 */
export function formatWorkflowResult(result: WorkflowRunResult): string {
  const lines: string[] = [];

  lines.push(`# ${result.workflowName}`);
  lines.push("");
  lines.push(`**Status:** ${result.status}`);
  lines.push(`**Run ID:** ${result.runId}`);
  lines.push(`**Started:** ${result.startedAt}`);
  if (result.finishedAt) {
    lines.push(`**Finished:** ${result.finishedAt}`);
  }
  lines.push("");

  // Show step summary
  lines.push("## Steps");
  lines.push("");

  const steps = Object.values(result.stepResults).sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  for (const step of steps) {
    const statusIcon = step.status === "completed" ? "✓" : "✗";
    const statusText = step.status === "completed" ? "Completed" : "Failed";
    lines.push(`- ${statusIcon} **${step.stepTitle}** (${step.agentName}): ${statusText}`);

    if (step.status === "failed" && step.error) {
      lines.push(`  - Error: ${step.error}`);
    }
  }

  lines.push("");

  // Show final output
  if (result.status === "completed") {
    lines.push("## Result");
    lines.push("");
    lines.push(result.finalText);
  } else if (result.error) {
    lines.push("## Error");
    lines.push("");
    lines.push(result.error);
  }

  return lines.join("\n");
}
