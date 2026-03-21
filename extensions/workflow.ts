// extensions/workflow.ts - Workflow command extension for pi

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  executeWorkflowCommand,
  parseWorkflowCommandArgs,
  type WorkflowCommandExecution,
  type WorkflowCommandObserver,
} from "../src/extension/commands/workflow";
import { createDefaultRegistry } from "../src/registry";
import { formatWorkflowResult, type ProgressEvent } from "../src/runtime/orchestrator";
import type { StepResultEnvelope, WorkflowRunResult } from "../src/workflow/types";

type WorkflowMessageDetails =
  | {
      kind: "step-complete";
      workflowId?: string;
      stepId: string;
      stepTitle?: string;
      agentName?: string;
      status: StepResultEnvelope["status"];
      summary: string;
      sessionId?: string;
      error?: string;
    }
  | {
      kind: "workflow-complete";
      workflowId: string;
      workflowName: string;
      status: WorkflowRunResult["status"];
      runId: string;
      durationMs: number;
      summary: string;
      finalText: string;
    };

/**
 * Register the /workflow command with pi.
 */
export default function (pi: ExtensionAPI) {
  pi.registerMessageRenderer("workflow-update", (message, _options, theme) => {
    const details = message.details as WorkflowMessageDetails | undefined;
    const fallbackContent = typeof message.content === "string"
      ? message.content
      : "";
    const content = renderWorkflowMessage(fallbackContent, details, theme);
    return new Text(content, 0, 0);
  });

  pi.registerCommand("workflow", {
    description: "Inspect and run multi-agent workflows",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parsedArgs = parseWorkflowCommandArgs(args.split(/\s+/).filter(Boolean));

      // Create registry for agent resolution
      const registry = await createDefaultRegistry(ctx.cwd);

      const progressState = createProgressState();
      const observer: WorkflowCommandObserver = {
        onProgress: (event) => {
          updateWorkflowUi(ctx, progressState, event);
          maybeSendProgressMessage(pi, progressState, event);
        },
        onResult: (result, durationMs) => {
          updateWorkflowResultUi(ctx, progressState, result, durationMs);
          pi.sendMessage({
            customType: "workflow-update",
            display: true,
            content: formatWorkflowResult(result),
            details: {
              kind: "workflow-complete",
              workflowId: result.workflowId,
              workflowName: result.workflowName,
              status: result.status,
              runId: result.runId,
              durationMs,
              summary: result.summary,
              finalText: result.finalText,
            } satisfies WorkflowMessageDetails,
          });
        },
      };

      // Execute the workflow command
      try {
        const execution = await executeWorkflowCommand(parsedArgs, registry, observer);
        finalizeWorkflowUi(ctx, progressState, execution);
      } catch (error) {
        ctx.ui.setStatus("workflow", undefined);
        const errorMessage = error instanceof Error ? error.message : String(error);
        ctx.ui.setWidget("workflow", [
          "Workflow failed",
          errorMessage,
        ]);
        ctx.ui.notify(`Workflow error: ${errorMessage}`, "error");
        throw error;
      }
    },
  });
}

interface WorkflowProgressState {
  workflowId?: string;
  workflowName?: string;
  runningSteps: Map<string, { title?: string; agentName?: string; sessionId?: string }>;
  completedSteps: Array<{
    stepId: string;
    title?: string;
    agentName?: string;
    sessionId?: string;
    status: StepResultEnvelope["status"];
    summary: string;
  }>;
}

function createProgressState(): WorkflowProgressState {
  return {
    runningSteps: new Map(),
    completedSteps: [],
  };
}

function updateWorkflowUi(
  ctx: ExtensionCommandContext,
  state: WorkflowProgressState,
  event: ProgressEvent
): void {
  switch (event.type) {
    case "workflow:start":
      state.workflowId = event.workflowId;
      state.workflowName = event.workflowName;
      ctx.ui.setStatus("workflow", `Workflow ${event.workflowName} starting`);
      ctx.ui.setWidget("workflow", [
        `Workflow: ${event.workflowName}`,
        "Status: starting",
      ]);
      break;
    case "step:start":
      state.runningSteps.set(event.stepId, {
        title: event.stepTitle,
        agentName: event.agentName,
        sessionId: event.sessionId,
      });
      ctx.ui.setStatus("workflow", `Running ${event.stepTitle} (${event.agentName})`);
      ctx.ui.setWidget("workflow", buildWorkflowWidget(state));
      break;
    case "step:running": {
      const running = state.runningSteps.get(event.stepId);
      if (running) {
        running.sessionId = event.sessionId;
      }
      ctx.ui.setWidget("workflow", buildWorkflowWidget(state));
      break;
    }
    case "step:complete": {
      const running = state.runningSteps.get(event.stepId);
      state.runningSteps.delete(event.stepId);
      state.completedSteps.push({
        stepId: event.stepId,
        title: running?.title,
        agentName: running?.agentName,
        sessionId: running?.sessionId,
        status: event.status,
        summary: event.summary,
      });
      ctx.ui.setStatus("workflow", `Completed ${event.stepId}: ${event.status}`);
      ctx.ui.setWidget("workflow", buildWorkflowWidget(state));
      break;
    }
    case "workflow:cancelled":
      ctx.ui.setStatus("workflow", `Workflow cancelled: ${event.reason}`);
      break;
    case "workflow:timeout":
      ctx.ui.setStatus("workflow", `Workflow timed out after ${event.timeoutMs}ms`);
      break;
    case "workflow:error":
      ctx.ui.setStatus("workflow", `Workflow error: ${event.error}`);
      break;
    default:
      break;
  }
}

function maybeSendProgressMessage(
  pi: ExtensionAPI,
  state: WorkflowProgressState,
  event: ProgressEvent
): void {
  if (event.type !== "step:complete") {
    return;
  }

  const completed = state.completedSteps.find((step) => step.stepId === event.stepId);
  const running = state.runningSteps.get(event.stepId);
  pi.sendMessage({
    customType: "workflow-update",
    display: true,
    content: formatStepCompletionMessage(completed, event),
    details: {
      kind: "step-complete",
      workflowId: state.workflowId,
      stepId: event.stepId,
      stepTitle: completed?.title,
      agentName: completed?.agentName ?? running?.agentName,
      status: event.status,
      summary: event.summary,
      sessionId: completed?.sessionId ?? running?.sessionId,
      error: event.status === "failed" || event.status === "cancelled" || event.status === "timed_out"
        ? event.summary
        : undefined,
    } satisfies WorkflowMessageDetails,
  });
}

function updateWorkflowResultUi(
  ctx: ExtensionCommandContext,
  state: WorkflowProgressState,
  result: WorkflowRunResult,
  durationMs: number
): void {
  const statusText = `${result.workflowName}: ${result.status} in ${formatDuration(durationMs)}`;
  ctx.ui.setStatus("workflow", statusText);
  ctx.ui.setWidget("workflow", [
    `Workflow: ${result.workflowName}`,
    `Status: ${result.status}`,
    `Run ID: ${result.runId}`,
    `Duration: ${formatDuration(durationMs)}`,
    `Steps: ${Object.keys(result.stepResults).length}`,
    result.summary ? `Summary: ${result.summary}` : "Summary: n/a",
  ]);
  state.runningSteps.clear();
}

function finalizeWorkflowUi(
  ctx: ExtensionCommandContext,
  state: WorkflowProgressState,
  execution?: WorkflowCommandExecution | void
): void {
  if (!execution) {
    return;
  }

  const result = execution.result;
  const widgetLines = [
    `Workflow: ${result.workflowName}`,
    `Status: ${result.status}`,
    `Run ID: ${result.runId}`,
    `Duration: ${formatDuration(execution.durationMs)}`,
    `Completed steps: ${state.completedSteps.length}`,
  ];
  ctx.ui.setWidget("workflow", widgetLines);
}

function buildWorkflowWidget(state: WorkflowProgressState): string[] {
  const lines = [
    `Workflow: ${state.workflowName ?? state.workflowId ?? "workflow"}`,
    `Running: ${state.runningSteps.size}`,
    `Completed: ${state.completedSteps.length}`,
  ];

  for (const [stepId, step] of state.runningSteps.entries()) {
    lines.push(`• ${step.title ?? stepId} (${step.agentName ?? "agent"})`);
  }

  const recentCompleted = state.completedSteps.slice(-3);
  for (const step of recentCompleted) {
    lines.push(`✓ ${step.title ?? step.stepId}: ${step.status}`);
  }

  return lines;
}

function formatStepCompletionMessage(
  completed:
    | { stepId: string; title?: string; agentName?: string; status: StepResultEnvelope["status"]; summary: string }
    | undefined,
  event: Extract<ProgressEvent, { type: "step:complete" }>
): string {
  const title = completed?.title ?? event.stepId;
  const agent = completed?.agentName ? ` by ${completed.agentName}` : "";
  const summary = event.summary ? `\n${event.summary}` : "";
  return `Step ${title}${agent} finished with status ${event.status}.${summary}`;
}

function renderWorkflowMessage(
  fallbackContent: string,
  details: WorkflowMessageDetails | undefined,
  theme: ExtensionCommandContext["ui"]["theme"]
): string {
  if (!details) {
    return fallbackContent;
  }

  if (details.kind === "step-complete") {
    const color =
      details.status === "succeeded" ? "success" :
      details.status === "cancelled" ? "warning" :
      details.status === "timed_out" ? "warning" : "error";
    const header = theme.fg(color, `[workflow step] ${details.stepTitle ?? details.stepId}`);
    const session = details.sessionId ? `\nSession: ${details.sessionId}` : "";
    const agent = details.agentName ? `\nAgent: ${details.agentName}` : "";
    const error = details.error ? `\nError: ${details.error}` : "";
    return `${header}\nStatus: ${details.status}${agent}${session}\nSummary: ${details.summary}${error}`;
  }

  const color = details.status === "succeeded" ? "success" : details.status === "cancelled" ? "warning" : "error";
  const header = theme.fg(color, `[workflow result] ${details.workflowName}`);
  const summary = details.summary ? `\nSummary: ${details.summary}` : "";
  const output = details.finalText ? `\nFinal output:\n${details.finalText}` : "";
  return `${header}\nStatus: ${details.status}\nRun ID: ${details.runId}\nDuration: ${formatDuration(details.durationMs)}${summary}${output}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}
