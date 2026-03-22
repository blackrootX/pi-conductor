// extensions/workflow.ts - Workflow command extension for pi

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import {
  cleanupWorkflowStorage,
  executeWorkflowCommand,
  getConfiguredWorkflows,
  getWorkflowSettingsContext,
  parseWorkflowCommandArgs,
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
import { getWorkflowDefinition, listWorkflowDefinitions, saveWorkflowAgentListTemplate, saveWorkflowTemplate } from "../src/workflow/templates";
import type { WorkflowApprovalRequest, WorkflowApprovalResult } from "../src/workflow/approval";
import type { AgentSpec } from "../src/types";

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
    }
  | {
      kind: "approval-requested";
      workflowId: string;
      stepId: string;
      stepTitle: string;
      agentName: string;
      skills: string[];
    }
  | {
      kind: "approval-resolved";
      workflowId?: string;
      stepId: string;
      approved: boolean;
      reason?: string;
    }
  | {
      kind: "cleanup-complete";
      target: "sessions" | "runs" | "all";
      summary: string;
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
      const parsedArgs = parseWorkflowCommandArgs(tokenizeCommandArgs(args));
      const trimmedArgs = args.trim();

      // Create registry for agent resolution
      const registry = await createDefaultRegistry(ctx.cwd);

      const progressState = createProgressState();
      const observer: WorkflowCommandObserver = {
        onProgress: (event) => {
          updateWorkflowUi(ctx, progressState, event);
          maybeSendProgressMessage(pi, progressState, event);
        },
        onApprovalRequest: (request) => requestWorkflowApproval(pi, ctx, request),
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
          execution = await executeWorkflowCommand({ ...parsedArgs, cwd: ctx.cwd }, registry, observer);
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
  if (parsedArgs.help || parsedArgs.list || parsedArgs.show || parsedArgs.add || parsedArgs.remove || parsedArgs.run || parsedArgs.cleanup) {
    if (!parsedArgs.save) {
      return false;
    }
  }

  if (parsedArgs.save) {
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
    "Save workflow template",
    "Cleanup artifacts",
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
      await addWorkflowFromPiUi(ctx, registry);
      return;
    case "Remove workflow":
      await removeWorkflowFromPiUi(ctx);
      return;
    case "Settings":
      await runNativeWorkflowSettings(ctx);
      return;
    case "Save workflow template":
      await saveWorkflowTemplateFromPiUi(ctx);
      return;
    case "Cleanup artifacts":
      await cleanupWorkflowFromPiUi(pi, ctx);
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
  const workflows = await getConfiguredWorkflows(ctx.cwd);
  if (workflows.length === 0) {
    throw new Error("No workflows found. Create one with /workflow -> Add workflow.");
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
    { ...parsedArgs, run: workflow.id, task, cwd: ctx.cwd },
    registry,
    observer
  ) as Promise<WorkflowCommandExecution | void>;
}

async function showConfiguredWorkflowsInPi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = await getConfiguredWorkflows(ctx.cwd);
  if (workflows.length === 0) {
    ctx.ui.notify("No workflows found", "info");
    return;
  }

  ctx.ui.setWidget("workflow-config", workflows.map((workflow, index) =>
    `${index + 1}. ${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""}`
  ));
  ctx.ui.notify(`Loaded ${workflows.length} workflow(s)`, "info");
}

async function addWorkflowFromPiUi(
  ctx: ExtensionCommandContext,
  registry: Awaited<ReturnType<typeof createDefaultRegistry>>
): Promise<void> {
  const scope = await ctx.ui.select("Create workflow in", ["project", "user"]);
  if (!scope) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    return;
  }

  const agents = (await registry.listAgents())
    .sort((a, b) => a.id.localeCompare(b.id));

  if (agents.length === 0) {
    ctx.ui.notify("No agents available to build a workflow", "warning");
    return;
  }

  const selectedAgents = await selectWorkflowAgents(ctx, agents);
  if (selectedAgents.length === 0) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    ctx.ui.setWidget("workflow-builder", []);
    return;
  }

  const defaultWorkflowId = selectedAgents.map((agent) => agent.id).join("-");
  const workflowId = (await ctx.ui.input("Workflow id:", defaultWorkflowId))?.trim();
  if (!workflowId) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    ctx.ui.setWidget("workflow-builder", []);
    return;
  }

  const description = (await ctx.ui.input("Description (optional):", ""))?.trim() || undefined;

  try {
    await saveWorkflowAgentListTemplate(
      workflowId,
      selectedAgents.map((agent) => agent.id),
      scope as SettingsScope,
      ctx.cwd,
      description
    );
    ctx.ui.notify(`Created workflow: ${workflowId} (${scope})`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to create workflow: ${message}`, "error");
  } finally {
    ctx.ui.setWidget("workflow-builder", []);
  }
}

async function removeWorkflowFromPiUi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = (await listWorkflowDefinitions(ctx.cwd)).filter((workflow) => workflow.source !== "built-in");
  if (workflows.length === 0) {
    ctx.ui.notify("No custom workflows available to remove", "info");
    return;
  }

  const selected = await ctx.ui.select(
    "Remove workflow",
    workflows.map((workflow) => `${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""} [${workflow.source}]`)
  );
  if (!selected) {
    return;
  }

  const workflowId = selected.split(" [")[0].split(" - ")[0];
  await executeWorkflowCommand({ remove: workflowId, cwd: ctx.cwd });
  ctx.ui.notify(`Removed workflow: ${workflowId}`, "info");
}

async function saveWorkflowTemplateFromPiUi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = await listWorkflowDefinitions(ctx.cwd);
  const selected = await ctx.ui.select(
    "Save workflow template",
    workflows.map((workflow) => `${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""} [${workflow.source}]`)
  );
  if (!selected) {
    return;
  }

  const workflowId = selected.split(" [")[0].split(" - ")[0];
  const resolved = await getWorkflowDefinition(workflowId, ctx.cwd);
  if (!resolved) {
    ctx.ui.notify(`Unknown workflow: ${workflowId}`, "error");
    return;
  }

  const targetId = (await ctx.ui.input("New workflow template id:", workflowId))?.trim();
  if (!targetId) {
    ctx.ui.notify("Template save cancelled", "info");
    return;
  }

  const scope = await ctx.ui.select("Save workflow template to", ["project", "user"]);
  if (!scope) {
    ctx.ui.notify("Template save cancelled", "info");
    return;
  }

  try {
    await saveWorkflowTemplate(
      {
        ...resolved.workflow,
        id: targetId,
      },
      scope as "project" | "user",
      ctx.cwd
    );
    ctx.ui.notify(`Saved workflow template: ${targetId} (${scope})`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to save workflow template: ${message}`, "error");
  }
}

async function cleanupWorkflowFromPiUi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext
): Promise<void> {
  const choice = await ctx.ui.select("Cleanup workflow artifacts", [
    "Session scratch data",
    "Run artifacts",
    "Everything",
  ]);

  if (!choice) {
    ctx.ui.notify("Cleanup cancelled", "info");
    return;
  }

  const target =
    choice === "Session scratch data" ? "sessions" :
    choice === "Run artifacts" ? "runs" : "all";

  try {
    const summary = await cleanupWorkflowStorage(target, ctx.cwd);
    ctx.ui.notify(summary, "info");
    pi.sendMessage({
      customType: "workflow-update",
      display: true,
      content: summary,
      details: {
        kind: "cleanup-complete",
        target,
        summary,
      } satisfies WorkflowMessageDetails,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Cleanup failed: ${message}`, "error");
  }
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
  approvalPending?: {
    stepId: string;
    stepTitle: string;
    agentName: string;
  };
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
      state.approvalPending = undefined;
      ctx.ui.setWidget("workflow-approval", []);
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
    case "step:approval-requested":
      state.approvalPending = {
        stepId: event.stepId,
        stepTitle: event.stepTitle,
        agentName: event.agentName,
      };
      ctx.ui.setStatus("workflow", `Approval needed for ${event.stepTitle} (${event.agentName})`);
      ctx.ui.setWidget("workflow", buildWorkflowWidget(state));
      break;
    case "step:approval-resolved":
      if (state.approvalPending?.stepId === event.stepId) {
        state.approvalPending = undefined;
      }
      ctx.ui.setWidget("workflow-approval", []);
      ctx.ui.setStatus(
        "workflow",
        event.approved
          ? `Approval granted for ${event.stepId}`
          : `Approval rejected for ${event.stepId}${event.reason ? `: ${event.reason}` : ""}`
      );
      ctx.ui.setWidget("workflow", buildWorkflowWidget(state));
      break;
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
      ctx.ui.setWidget("workflow-approval", []);
      ctx.ui.setStatus("workflow", `Workflow cancelled: ${event.reason}`);
      break;
    case "workflow:timeout":
      ctx.ui.setWidget("workflow-approval", []);
      ctx.ui.setStatus("workflow", `Workflow timed out after ${event.timeoutMs}ms`);
      break;
    case "workflow:error":
      ctx.ui.setWidget("workflow-approval", []);
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
    if (event.type === "step:approval-resolved") {
      pi.sendMessage({
        customType: "workflow-update",
        display: true,
        content: event.approved
          ? `Approval granted for ${event.stepId}.`
          : `Approval rejected for ${event.stepId}${event.reason ? `: ${event.reason}` : ""}.`,
        details: {
          kind: "approval-resolved",
          workflowId: state.workflowId,
          stepId: event.stepId,
          approved: event.approved,
          reason: event.reason,
        } satisfies WorkflowMessageDetails,
      });
    }
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
  ctx.ui.setWidget("workflow-approval", []);
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

  if (state.approvalPending) {
    lines.push(`Approval: ${state.approvalPending.stepTitle} (${state.approvalPending.agentName})`);
  }

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

  if (details.kind === "approval-requested") {
    const header = theme.fg("warning", `[workflow approval] ${details.stepTitle}`);
    const agent = `\nAgent: ${details.agentName}`;
    const skills = details.skills.length > 0 ? `\nSkills: ${details.skills.join(", ")}` : "";
    return `${header}${agent}${skills}\nAwaiting approval before execution.`;
  }

  if (details.kind === "approval-resolved") {
    const color = details.approved ? "success" : "warning";
    const header = theme.fg(color, `[workflow approval] ${details.stepId}`);
    const reason = details.reason ? `\nReason: ${details.reason}` : "";
    return `${header}\nDecision: ${details.approved ? "approved" : "rejected"}${reason}`;
  }

  if (details.kind === "cleanup-complete") {
    const header = `[workflow cleanup] ${details.target}`;
    return `${header}\n${details.summary}`;
  }

  const color = details.status === "succeeded" ? "success" : details.status === "cancelled" ? "warning" : "error";
  const header = theme.fg(color, `[workflow result] ${details.workflowName}`);
  const summary = details.summary ? `\nSummary: ${details.summary}` : "";
  const output = details.finalText ? `\nFinal output:\n${details.finalText}` : "";
  return `${header}\nStatus: ${details.status}\nRun ID: ${details.runId}\nDuration: ${formatDuration(details.durationMs)}${summary}${output}`;
}

async function requestWorkflowApproval(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  request: WorkflowApprovalRequest
): Promise<WorkflowApprovalResult> {
  pi.sendMessage({
    customType: "workflow-update",
    display: true,
    content: `Approval required for ${request.stepTitle} (${request.agentName}).`,
    details: {
      kind: "approval-requested",
      workflowId: request.workflowId,
      stepId: request.stepId,
      stepTitle: request.stepTitle,
      agentName: request.agentName,
      skills: request.skills,
    } satisfies WorkflowMessageDetails,
  });

  const messageLines = [
    `Workflow: ${request.workflowName}`,
    `Step: ${request.stepTitle}`,
    `Agent: ${request.agentName}`,
  ];

  if (request.skills.length > 0) {
    messageLines.push(`Skills: ${request.skills.join(", ")}`);
  }

  messageLines.push("");
  messageLines.push(request.stepPrompt);

  ctx.ui.setWidget("workflow-approval", messageLines);

  const decision = await ctx.ui.select(
    "Approve workflow step?",
    [
      `Approve ${request.stepTitle}`,
      `Reject ${request.stepTitle}`,
    ]
  );

  if (decision?.startsWith("Approve")) {
    return { approved: true };
  }

  const reason = (
    await ctx.ui.input(
      "Why reject this step? (optional)",
      "Step approval was rejected"
    )
  )?.trim();

  return {
    approved: false,
    reason: reason || "Step approval was rejected",
  };
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

async function selectWorkflowAgents(
  ctx: ExtensionCommandContext,
  agents: AgentSpec[]
): Promise<AgentSpec[]> {
  const selected: AgentSpec[] = [];

  while (true) {
    const lines = [
      "Building workflow",
      ...selected.map((agent, index) => `${index + 1}. ${agent.id}${agent.description ? ` - ${agent.description}` : ""}`),
    ];
    ctx.ui.setWidget("workflow-builder", lines);

    const options = [
      ...agents.map((agent) => `${agent.id}${agent.description ? ` - ${agent.description}` : ""} [${agent.source}]`),
      "Done",
    ];

    const choice = await ctx.ui.select("Select agent for workflow", options);
    if (!choice) {
      return [];
    }

    if (choice === "Done") {
      if (selected.length === 0) {
        ctx.ui.notify("Select at least one agent before finishing", "warning");
        continue;
      }
      return selected;
    }

    const agentId = choice.split(" [")[0].split(" - ")[0];
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      ctx.ui.notify(`Unknown agent: ${agentId}`, "warning");
      continue;
    }

    selected.push(agent);
  }
}

function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    current += "\\";
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
