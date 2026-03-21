// extensions/workflow.ts - Workflow command extension for pi

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  executeWorkflowCommand,
  getConfiguredWorkflows,
  getWorkflowSettingsContext,
  parseWorkflowCommandArgs,
  resolveWorkflowIdForAdd,
  type WorkflowCommandExecution,
  type WorkflowCommandObserver,
  type EffectiveWorkflowSettings,
  type SettingsScope,
  type WorkflowDisplayStrategy,
  type WorkflowMultiplexer,
  writeWorkflowSettings,
} from "../src/extension/commands/workflow";
import { createDefaultRegistry } from "../src/registry";
import { formatWorkflowResult, type ProgressEvent } from "../src/runtime/orchestrator";
import type { StepResultEnvelope, WorkflowRunResult } from "../src/workflow/types";
import { listPresets } from "../src/workflow/presets";

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
      const trimmedArgs = args.trim();

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
        let execution: WorkflowCommandExecution | void;

        if (shouldUseNativeWorkflowUi(parsedArgs, trimmedArgs)) {
          execution = await runNativeWorkflowUi(pi, ctx, parsedArgs, registry, observer);
        } else {
          execution = await executeWorkflowCommand(parsedArgs, registry, observer);
        }

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

function shouldUseNativeWorkflowUi(
  parsedArgs: ReturnType<typeof parseWorkflowCommandArgs>,
  rawArgs: string
): boolean {
  if (parsedArgs.help || parsedArgs.list || parsedArgs.show || parsedArgs.add || parsedArgs.remove || parsedArgs.run) {
    return false;
  }

  if (parsedArgs.settings || rawArgs === "settings") {
    return true;
  }

  return true;
}

async function runNativeWorkflowUi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  parsedArgs: ReturnType<typeof parseWorkflowCommandArgs>,
  registry: Awaited<ReturnType<typeof createDefaultRegistry>>,
  observer: WorkflowCommandObserver
): Promise<WorkflowCommandExecution | void> {
  if (parsedArgs.settings || parsedArgs.task === "settings") {
    await runNativeWorkflowSettings(ctx);
    return;
  }

  if (parsedArgs.task?.trim()) {
    return promptAndRunWorkflowFromPiUi(parsedArgs.task.trim(), ctx, registry, observer, parsedArgs);
  }

  const choice = await ctx.ui.select("Workflow", [
    "Run workflow",
    "List workflows",
    "Add workflow",
    "Remove workflow",
    "Settings",
  ]);

  if (!choice) {
    ctx.ui.notify("Workflow menu cancelled", "info");
    return;
  }

  switch (choice) {
    case "Run workflow":
      return promptAndRunWorkflowFromPiUi(undefined, ctx, registry, observer, parsedArgs);
    case "List workflows":
      await showConfiguredWorkflowsInPi(ctx);
      return;
    case "Add workflow":
      await addWorkflowFromPiUi(ctx);
      return;
    case "Remove workflow":
      await removeWorkflowFromPiUi(ctx);
      return;
    case "Settings":
      await runNativeWorkflowSettings(ctx);
      return;
    default:
      return;
  }
}

async function promptAndRunWorkflowFromPiUi(
  initialTask: string | undefined,
  ctx: ExtensionCommandContext,
  registry: Awaited<ReturnType<typeof createDefaultRegistry>>,
  observer: WorkflowCommandObserver,
  parsedArgs: ReturnType<typeof parseWorkflowCommandArgs>
): Promise<WorkflowCommandExecution | void> {
  const workflows = await getConfiguredWorkflows();
  if (workflows.length === 0) {
    throw new Error("No configured workflows found. Use /workflow add <workflow-id> to add one.");
  }

  const options = workflows.map((workflow) =>
    workflow.description ? `${workflow.id} - ${workflow.description}` : workflow.id
  );
  const selected = await pickFromList(ctx, "Select workflow", options);
  if (!selected) {
    return;
  }

  const workflow = workflows[options.indexOf(selected)];
  const task = initialTask ?? await promptForTask(ctx, workflow.id);
  if (!task) {
    return;
  }

  return executeWorkflowCommand(
    { ...parsedArgs, run: workflow.id, task },
    registry,
    observer
  ) as Promise<WorkflowCommandExecution | void>;
}

async function showConfiguredWorkflowsInPi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = await getConfiguredWorkflows();
  if (workflows.length === 0) {
    ctx.ui.notify("No configured workflows found", "info");
    return;
  }

  ctx.ui.setWidget("workflow-config", workflows.map((workflow, index) =>
    `${index + 1}. ${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""}`
  ));
  ctx.ui.notify(`Loaded ${workflows.length} configured workflow(s)`, "info");
}

async function addWorkflowFromPiUi(ctx: ExtensionCommandContext): Promise<void> {
  const presets = listPresets();
  const configured = new Set((await getConfiguredWorkflows()).map((workflow) => workflow.id));
  const candidates = presets
    .filter((preset) => !configured.has(preset.id))
    .map((preset) => preset.description ? `${preset.id} - ${preset.description}` : preset.id);

  if (candidates.length === 0) {
    ctx.ui.notify("All known workflows are already configured", "info");
    return;
  }

  const selected = await ctx.ui.select("Add workflow", candidates);
  if (!selected) {
    return;
  }

  const workflowId = selected.split(" - ")[0];
  await executeWorkflowCommand({ add: workflowId });
  ctx.ui.notify(`Added workflow: ${workflowId}`, "info");
}

async function removeWorkflowFromPiUi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = await getConfiguredWorkflows();
  if (workflows.length === 0) {
    ctx.ui.notify("No configured workflows to remove", "info");
    return;
  }

  const selected = await ctx.ui.select(
    "Remove workflow",
    workflows.map((workflow) => workflow.description ? `${workflow.id} - ${workflow.description}` : workflow.id)
  );
  if (!selected) {
    return;
  }

  const workflowId = selected.split(" - ")[0];
  await executeWorkflowCommand({ remove: workflowId });
  ctx.ui.notify(`Removed workflow: ${workflowId}`, "info");
}

async function runNativeWorkflowSettings(ctx: ExtensionCommandContext): Promise<void> {
  const context = await getWorkflowSettingsContext(ctx.cwd);
  const settings: EffectiveWorkflowSettings = { ...context.settings };
  let scope: SettingsScope = context.scope;

  while (true) {
    const choice = await ctx.ui.select("Workflow settings", [
      `Multiplexer: ${settings.conductorWorkflowMultiplexer}`,
      `Display: ${settings.conductorWorkflowDisplay}`,
      `Save scope: ${scope}`,
      "Save",
    ]);

    if (!choice) {
      ctx.ui.notify("Settings cancelled", "info");
      return;
    }

    if (choice.startsWith("Multiplexer:")) {
      const selected = await ctx.ui.select("Select multiplexer", ["none", "zellij"]);
      if (selected) {
        settings.conductorWorkflowMultiplexer = selected as WorkflowMultiplexer;
      }
      continue;
    }

    if (choice.startsWith("Display:")) {
      if (settings.conductorWorkflowMultiplexer === "none") {
        ctx.ui.notify("Display is only used when multiplexer is zellij", "warning");
        continue;
      }
      const selected = await ctx.ui.select("Select display strategy", ["main-window", "split-pane"]);
      if (selected) {
        settings.conductorWorkflowDisplay = selected as WorkflowDisplayStrategy;
      }
      continue;
    }

    if (choice.startsWith("Save scope:")) {
      const selected = await ctx.ui.select("Save settings to", ["project", "user"]);
      if (selected) {
        scope = selected as SettingsScope;
      }
      continue;
    }

    await writeWorkflowSettings({
      conductorWorkflow: settings.conductorWorkflow,
      conductorWorkflowMultiplexer: settings.conductorWorkflowMultiplexer,
      conductorWorkflowDisplay: settings.conductorWorkflowDisplay,
    }, scope, ctx.cwd);
    ctx.ui.notify(`Workflow settings saved to ${scope} settings`, "info");
    return;
  }
}

async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[]
): Promise<string | undefined> {
  return items.length === 0 ? undefined : ctx.ui.select(title, items);
}

async function promptForTask(
  ctx: ExtensionCommandContext,
  workflowId: string
): Promise<string | undefined> {
  const value = await ctx.ui.input(`Task for ${workflowId}:`, "Describe the work");
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
