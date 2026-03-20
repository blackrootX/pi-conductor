// src/runtime/childSessionRunner.ts - Run steps in isolated child sessions

import type { AgentSpec } from "../types";
import type { ResolvedWorkflowStep, StepResultEnvelope, StepArtifact } from "../workflow/types";
import type { ChildSessionContext } from "./contextBuilder";
import { buildChildSessionContext } from "./contextBuilder";

export interface ChildSessionOptions {
  /** Timeout for each step in milliseconds */
  timeout?: number;
  /** Callback when step status changes */
  onStatusChange?: (stepId: string, status: StepResultEnvelope["status"]) => void;
}

export interface SessionRunner {
  runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[]
  ): Promise<StepResultEnvelope>;
}

/**
 * Default session runner that executes steps.
 * This is a stub implementation - the actual execution depends on
 * the specific runtime environment (pi CLI, etc.)
 */
export class DefaultSessionRunner implements SessionRunner {
  private options: ChildSessionOptions;

  constructor(options: ChildSessionOptions = {}) {
    this.options = options;
  }

  async runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[]
  ): Promise<StepResultEnvelope> {
    const startedAt = new Date().toISOString();
    const sessionId = generateSessionId();

    // Build context
    const context = buildChildSessionContext(step, userTask, dependencyResults, allSteps);

    // Notify running
    this.options.onStatusChange?.(step.id, "running");

    try {
      // Execute the step (stub - actual implementation would call the agent)
      const result = await this.executeStep(context, step.agent);

      return {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId,
        status: "completed",
        summary: result.summary,
        artifact: result.artifact,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      return {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId,
        status: "failed",
        summary: "",
        artifact: { type: "text", value: "" },
        startedAt,
        finishedAt: new Date().toISOString(),
        error: errorMessage,
      };
    }
  }

  /**
   * Execute a step. Override this in subclasses for custom execution.
   */
  protected async executeStep(
    context: ChildSessionContext,
    agent: AgentSpec
  ): Promise<{ summary: string; artifact: StepArtifact }> {
    // Stub implementation - in a real system, this would:
    // 1. Spawn a child process or API call
    // 2. Inject the context as prompts
    // 3. Execute the agent
    // 4. Collect the result

    // For now, return a mock result
    return {
      summary: `Executed ${context.stepTitle} with ${context.agentName}. Processed ${context.dependencyOutputs.length} dependency outputs.`,
      artifact: {
        type: "text",
        value: JSON.stringify({
          step: context.stepTitle,
          agent: context.agentName,
          task: context.userTask,
          dependencies: context.dependencyOutputs.map((d) => d.stepId),
        }),
      },
    };
  }
}

/**
 * Mock session runner for testing - returns predefined results.
 */
export class MockSessionRunner implements SessionRunner {
  private mockResults: Map<string, StepResultEnvelope>;
  private delayMs: number;

  constructor(mockResults?: Map<string, StepResultEnvelope>, delayMs = 0) {
    this.mockResults = mockResults || new Map();
    this.delayMs = delayMs;
  }

  async runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[]
  ): Promise<StepResultEnvelope> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const context = buildChildSessionContext(step, userTask, dependencyResults, allSteps);
    const sessionId = generateSessionId();
    const startedAt = new Date().toISOString();

    // Check for predefined result
    const predefined = this.mockResults.get(step.id);
    if (predefined) {
      return {
        ...predefined,
        sessionId,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // Generate mock result
    return {
      stepId: step.id,
      stepTitle: step.title,
      agentId: step.agent.id,
      agentName: step.agent.name,
      sessionId,
      status: "completed",
      summary: `Mock result for ${context.stepTitle}`,
      artifact: {
        type: "text",
        value: `Mock artifact from ${context.agentName}`,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Generate a unique session ID.
 */
function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Check if a step can run (all dependencies complete).
 */
export function canStepRun(
  step: ResolvedWorkflowStep,
  results: Record<string, StepResultEnvelope>
): boolean {
  if (!step.dependsOn || step.dependsOn.length === 0) {
    return true;
  }

  return step.dependsOn.every((depId) => {
    const result = results[depId];
    return result && result.status === "completed";
  });
}

/**
 * Check if a step should continue based on failure policy.
 */
export function shouldContinueOnFailure(
  step: ResolvedWorkflowStep,
  failedStepId: string,
  onStepFailure: "abort" | "continue"
): boolean {
  // If the failed step is a dependency of this step, abort
  if (step.dependsOn?.includes(failedStepId)) {
    return false;
  }

  // Otherwise, respect the policy
  return onStepFailure === "continue";
}
