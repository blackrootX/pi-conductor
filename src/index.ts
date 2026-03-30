import { randomUUID } from "node:crypto";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
} from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { WorkflowConfig } from "./workflows.js";
import { DEFAULT_WORKFLOW_NAME, discoverWorkflows } from "./workflows.js";
import {
  type WorkflowDetails,
  isErrorResult,
  resumeWorkflowRun,
  runWorkflowByName,
} from "./workflow-runtime.js";
import {
  clearWorkflowRuntimeHooks,
  resolveWorkflowRuntimeHooks,
  setWorkflowRuntimeHooks,
  setWorkflowRuntimeHooksProvider,
  type WorkflowRuntimeHookContext,
  type WorkflowRuntimeHooksProvider,
} from "./workflow-hook-registry.js";
import {
  type WorkflowCardPayload,
  buildWorkflowCardPayload,
  renderWorkflowCardLines,
} from "./workflow-cards.js";
import { registerWorkflowMessageRenderer } from "./workflow-message-renderer.js";
import {
  WORKFLOW_MESSAGE_TYPE,
  appendWorkflowRunFinished,
  appendWorkflowRunStarted,
  appendWorkflowSelection,
  appendWorkflowStepFinished,
  appendWorkflowStepUpdated,
  buildWorkflowMessageContent,
  createInitialWorkflowDetails,
  createWorkflowMessageDetails,
  getLatestWorkflowSelection,
  getLatestWorkflowSnapshot,
} from "./workflow-session-entries.js";
import type { WorkflowRuntimeHooks } from "./workflow-hooks.js";
import {
  renderWorkflowResult,
  buildWorkflowCallPreview,
  buildSharedSummaryLine,
  getCurrentFocus,
  getTopReadyWorkItem,
  buildWorkflowVerificationSummary,
  aggregateUsage,
  formatUsageStats,
} from "./workflow-result-renderer.js";

const TOOL_POLICY_ENV = "PI_CONDUCTOR_ENFORCE_TOOLS";
const ALLOWED_TOOLS_ENV = "PI_CONDUCTOR_ALLOWED_TOOLS";

const ConductorParams = Type.Object({
  workflow: Type.String({
    description: "Name of the workflow to run",
  }),
  task: Type.String({
    description: "Runtime task input for the workflow",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the workflow run",
    }),
  ),
});

function tokenizeCommandArgs(input: string): string[] {
  const tokens: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    tokens.push(value.replace(/\\(["'])/g, "$1"));
  }
  return tokens;
}

function getWorkflowArgumentCompletions(
  cwd: string,
  prefix: string,
): Array<{ value: string; label: string }> | null {
  const trimmedPrefix = prefix.trimStart();
  const tokens = tokenizeCommandArgs(trimmedPrefix);
  const isCompletingWorkflowName =
    trimmedPrefix.length === 0 || !/\s/.test(trimmedPrefix);

  if (!isCompletingWorkflowName) return null;

  const workflowPrefix = tokens[0] ?? "";
  const completions = discoverWorkflows(cwd).workflows
    .filter((workflow) => workflow.name.startsWith(workflowPrefix))
    .map((workflow) => ({
      value: workflow.name,
      label: `${workflow.name} (${workflow.source})`,
    }));

  return completions.length > 0 ? completions : null;
}

function buildConductorInstruction(workflowName: string, task: string): string {
  return [
    "Use the `conductor` tool immediately.",
    `Run the workflow named "${workflowName}".`,
    "Pass the following task exactly as the tool's `task` argument.",
    "",
    task,
  ].join("\n");
}

function shouldAutoResumeBlockedWorkflow(
  text: string,
  snapshot: ReturnType<typeof getLatestWorkflowSnapshot>,
): boolean {
  const trimmed = text.trim();
  if (!snapshot || snapshot.status !== "blocked") return false;
  if (!trimmed) return false;
  if (trimmed.startsWith("/")) return false;
  if (trimmed.startsWith("!")) return false;
  if (/[?？]\s*$/.test(trimmed)) return false;

  const lower = trimmed.toLowerCase();
  const conversationalPrefixes = [
    "why",
    "what",
    "how",
    "show",
    "explain",
    "review",
    "fix",
    "debug",
    "help",
    "summarize",
    "compare",
    "list",
    "tell me",
    "can you",
    "could you",
    "would you",
    "will you",
    "please",
    "wait",
    "hold on",
    "stop",
    "cancel",
    "ignore",
    "never mind",
  ];
  if (conversationalPrefixes.some((prefix) => lower === prefix || lower.startsWith(`${prefix} `))) {
    return false;
  }

  if (/[:=\n]/.test(trimmed)) return true;
  if (trimmed.length > 280) return false;
  return trimmed.split(/\s+/).length <= 40;
}

function getResumeWorkflowCwd(
  ctx: ExtensionContext,
  snapshot: NonNullable<ReturnType<typeof getLatestWorkflowSnapshot>>,
): string {
  const selection = getLatestWorkflowSelection(ctx.sessionManager);
  if (
    selection?.cwd &&
    selection.workflowName === snapshot.workflowName &&
    selection.task === snapshot.userTask
  ) {
    return selection.cwd;
  }
  return ctx.cwd;
}

function getCurrentModelLabel(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

function setWorkflowCardsWidget(
  ctx: ExtensionContext,
  payload: WorkflowCardPayload | undefined,
) {
  if (!ctx.hasUI) return;
  if (!payload) {
    ctx.ui.setWidget("workflow-cards", undefined);
    return;
  }

  ctx.ui.setWidget(
    "workflow-cards",
    (_tui, theme) => {
      const text = new Text("", 0, 0);
      const isAnimated = payload.steps.some((step) => step.status === "running");
      const interval = isAnimated
        ? setInterval(() => {
            text.invalidate();
          }, 250)
        : undefined;

      return {
        render(width: number) {
          text.setText(
            renderWorkflowCardLines(payload, width, theme, {
              animationTick: Date.now(),
            }).join("\n"),
          );
          return text.render(width);
        },
        invalidate() {
          text.invalidate();
        },
        dispose() {
          if (interval) clearInterval(interval);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}


type WorkflowProgressTracker = {
  previousDetails?: WorkflowDetails;
};

function buildWorkflowSessionName(workflowName: string, task: string): string {
  const normalizedTask = task.trim().replace(/\s+/g, " ");
  if (!normalizedTask) return `workflow:${workflowName}`;
  const preview =
    normalizedTask.length > 48
      ? `${normalizedTask.slice(0, 45).trimEnd()}...`
      : normalizedTask;
  return `workflow:${workflowName} - ${preview}`;
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }
  return typeof error === "string" ? error.trim() || "Unknown error" : "Unknown error";
}

function emitWorkflowMessage(
  pi: ExtensionAPI,
  event: "run-started" | "step-updated" | "step-finished" | "run-finished",
  snapshot: ReturnType<typeof createWorkflowMessageDetails>["snapshot"],
): void {
  const details = createWorkflowMessageDetails(event, snapshot);
  pi.sendMessage(
    {
      customType: WORKFLOW_MESSAGE_TYPE,
      content: buildWorkflowMessageContent(details),
      display: true,
      details,
    },
    { triggerTurn: false },
  );
}

function syncWorkflowProgress(
  pi: ExtensionAPI,
  tracker: WorkflowProgressTracker,
  details: WorkflowDetails,
  currentModel?: string,
): void {
  const previous = tracker.previousDetails;
  if (!previous) {
    tracker.previousDetails = details;
    return;
  }

  for (let index = 0; index < details.state.steps.length; index++) {
    const previousStatus = previous.state.steps[index]?.status;
    const nextStatus = details.state.steps[index]?.status;
    if (!nextStatus || previousStatus === nextStatus) continue;

    if (nextStatus === "running") {
      const snapshot = appendWorkflowStepUpdated(pi, details, currentModel);
      emitWorkflowMessage(pi, "step-updated", snapshot);
      continue;
    }

    if (
      nextStatus === "done" ||
      nextStatus === "blocked" ||
      nextStatus === "failed"
    ) {
      const snapshot = appendWorkflowStepFinished(pi, details, currentModel);
      emitWorkflowMessage(pi, "step-finished", snapshot);
    }
  }

  tracker.previousDetails = details;
}

async function resumeBlockedWorkflowInSession(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  snapshot: NonNullable<ReturnType<typeof getLatestWorkflowSnapshot>>,
  clarification: string,
): Promise<void> {
  const currentModel = getCurrentModelLabel(ctx);
  const tracker: WorkflowProgressTracker = {};
  const resumeCwd = getResumeWorkflowCwd(ctx, snapshot);
  const runtimeHooks = await resolveWorkflowRuntimeHooks({
    cwd: resumeCwd,
    workflowName: snapshot.workflowName,
    task: snapshot.userTask,
    defaultModel: currentModel,
  });
  const handleWorkflowUpdate = (details: WorkflowDetails) => {
    const payload = buildWorkflowCardPayload(details, true, currentModel);
    setWorkflowCardsWidget(ctx, payload);
    syncWorkflowProgress(pi, tracker, details, currentModel);
  };

  const result = await resumeWorkflowRun(
    resumeCwd,
    snapshot.runId,
    clarification,
    currentModel,
    undefined,
    handleWorkflowUpdate,
    runtimeHooks,
  );

  const finalDetails = {
    workflowName: result.workflowName,
    steps: result.steps,
    workflowSource: result.workflowSource,
    workflowFilePath: result.workflowFilePath,
    runDir: result.runDir,
    results: result.results,
    state: result.state,
  };

  if (result.steps.length > 0) {
    setWorkflowCardsWidget(
      ctx,
      buildWorkflowCardPayload(finalDetails, false, currentModel),
    );
    const snapshotMessage = appendWorkflowRunFinished(
      pi,
      finalDetails,
      {
        finalText: result.finalText,
        errorMessage: result.errorMessage,
        isError: result.isError,
      },
      currentModel,
    );
    emitWorkflowMessage(pi, "run-finished", snapshotMessage);
  }

  if (ctx.hasUI) {
    if (result.isError) {
      ctx.ui.notify(result.errorMessage || "Workflow resume failed.", "error");
    } else {
      ctx.ui.notify(`Workflow "${result.workflowName}" resumed.`, "info");
    }
  }
}

function restoreWorkflowSummaryWidget(ctx: ExtensionContext): void {
  const snapshot = getLatestWorkflowSnapshot(ctx.sessionManager);
  setWorkflowCardsWidget(ctx, snapshot?.presentation);
}

async function resolveWorkflowCommandInput(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<{ workflowName: string; task: string } | undefined> {
  const { workflows } = discoverWorkflows(ctx.cwd);
  const workflowMap = new Map(workflows.map((workflow) => [workflow.name, workflow]));
  const tokens = tokenizeCommandArgs(args.trim());

  if (tokens.length === 0) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Provide a workflow name and task when no interactive UI is available.",
        "error",
      );
      return undefined;
    }

    const options = workflows.map(
      (workflow) => `${workflow.name} (${workflow.source})`,
    );
    const choice = await ctx.ui.select("Select workflow", options);
    if (!choice) return undefined;
    const index = options.indexOf(choice);
    const selected = workflows[index];
    const task = await ctx.ui.input(
      `Run workflow: ${selected.name}`,
      "implement auth",
    );
    if (!task?.trim()) return undefined;
    return { workflowName: selected.name, task: task.trim() };
  }

  const maybeWorkflow = workflowMap.get(tokens[0]);
  if (maybeWorkflow) {
    const remainingTask = tokens.slice(1).join(" ").trim();
    if (remainingTask) {
      return { workflowName: maybeWorkflow.name, task: remainingTask };
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("Provide a task after the workflow name.", "error");
      return undefined;
    }
    const task = await ctx.ui.input(
      `Run workflow: ${maybeWorkflow.name}`,
      "implement auth",
    );
    if (!task?.trim()) return undefined;
    return { workflowName: maybeWorkflow.name, task: task.trim() };
  }

  return {
    workflowName: DEFAULT_WORKFLOW_NAME,
    task: tokens.join(" ").trim(),
  };
}

function getWorkflowAllowedToolsFromEnv(): string[] | null {
  if (process.env[TOOL_POLICY_ENV] !== "1") return null;
  const raw = process.env[ALLOWED_TOOLS_ENV] ?? "";
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export default function registerExtension(pi: ExtensionAPI) {
  let commandCompletionCwd = process.cwd();
  const updateCommandCompletionCwd = (cwd: string) => {
    commandCompletionCwd = cwd;
  };

  registerWorkflowMessageRenderer(pi);

  pi.on("context", async (event) => ({
    messages: event.messages.filter(
      (message) =>
        !(
          message.role === "custom" &&
          message.customType === WORKFLOW_MESSAGE_TYPE
        ),
    ),
  }));

  const restoreWorkflowUi = (_event: unknown, ctx: ExtensionContext) => {
    updateCommandCompletionCwd(ctx.cwd);
    restoreWorkflowSummaryWidget(ctx);
  };

  pi.on("session_start", restoreWorkflowUi);
  pi.on("session_switch", restoreWorkflowUi);
  pi.on("session_fork", restoreWorkflowUi);
  pi.on("session_tree", restoreWorkflowUi);

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension") {
      return { action: "continue" as const };
    }

    const snapshot = getLatestWorkflowSnapshot(ctx.sessionManager);
    if (!snapshot || !shouldAutoResumeBlockedWorkflow(event.text, snapshot)) {
      return { action: "continue" as const };
    }

    const replyText = event.text.trim();

    if (ctx.hasUI) {
      ctx.ui.notify(
        `Resuming blocked workflow "${snapshot.workflowName}" with your reply.`,
        "info",
      );
      ctx.ui.setToolsExpanded(true);
    }

    await resumeBlockedWorkflowInSession(pi, ctx, snapshot, replyText);
    return { action: "handled" as const };
  });

  const workflowAllowedTools = getWorkflowAllowedToolsFromEnv();
  if (workflowAllowedTools) {
    const allowedToolSet = new Set(workflowAllowedTools);

    pi.on("before_agent_start", async () => {
      pi.setActiveTools(workflowAllowedTools);
      return undefined;
    });

    pi.on("tool_call", async (event) => {
      if (allowedToolSet.has(event.toolName)) return undefined;
      const allowedList = workflowAllowedTools.length > 0
        ? workflowAllowedTools.join(", ")
        : "(no tools allowed)";
      return {
        block: true,
        reason: `Tool "${event.toolName}" is not allowed for this workflow step. Allowed tools: ${allowedList}.`,
      };
    });
  }

  pi.registerTool({
    name: "conductor",
    label: "Conductor",
    description:
      "Run a named sequential workflow using agents discovered from project, global, and built-in definitions.",
    promptSnippet:
      "conductor(workflow, task): run a named workflow from .pi/workflow.yaml or ~/.pi/agent/workflow.yaml",
    promptGuidelines: [
      "Use `conductor` when the user wants to run a named workflow such as `plan-build`.",
      "Prefer `conductor` over manually recreating workflow steps yourself.",
    ],
    parameters: ConductorParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtimeCwd = params.cwd ?? ctx.cwd;
      updateCommandCompletionCwd(runtimeCwd);
      const currentModel = getCurrentModelLabel(ctx);
      const workflowConfig = discoverWorkflows(runtimeCwd).workflows.find(
        (workflow) => workflow.name === params.workflow,
      );
      const runId = randomUUID();
      const tracker: WorkflowProgressTracker = {};

      pi.setSessionName(buildWorkflowSessionName(params.workflow, params.task));
      appendWorkflowSelection(pi, {
        workflowName: params.workflow,
        task: params.task,
        cwd: runtimeCwd,
        selectedAt: new Date().toISOString(),
      });

      if (workflowConfig) {
        const initialDetails = createInitialWorkflowDetails(
          workflowConfig,
          params.task,
          runId,
        );
        tracker.previousDetails = initialDetails;
        setWorkflowCardsWidget(
          ctx,
          buildWorkflowCardPayload(initialDetails, true, currentModel),
        );
        const snapshot = appendWorkflowRunStarted(pi, initialDetails, currentModel);
        emitWorkflowMessage(pi, "run-started", snapshot);
      }

      try {
        const runtimeHooks = await resolveWorkflowRuntimeHooks({
          cwd: runtimeCwd,
          workflowName: params.workflow,
          task: params.task,
          defaultModel: currentModel,
        });
        const handleWorkflowUpdate = (details: WorkflowDetails) => {
          const payload = buildWorkflowCardPayload(details, true, currentModel);
          setWorkflowCardsWidget(
            ctx,
            payload,
          );
          syncWorkflowProgress(pi, tracker, details, currentModel);
          onUpdate?.({
            content: [
              {
                type: "text",
                text: payload.lastProgress || "(running...)",
              },
            ],
            details,
          });
        };

        const result = await runWorkflowByName(
          runtimeCwd,
          params.workflow,
          params.task,
          currentModel,
          signal,
          handleWorkflowUpdate,
          runtimeHooks,
          runId,
        );
        const finalDetails = {
          workflowName: result.workflowName,
          steps: result.steps,
          workflowSource: result.workflowSource,
          workflowFilePath: result.workflowFilePath,
          runDir: result.runDir,
          results: result.results,
          state: result.state,
        };

        if (result.steps.length > 0) {
          setWorkflowCardsWidget(
            ctx,
            buildWorkflowCardPayload(finalDetails, false, currentModel),
          );
          const snapshot = appendWorkflowRunFinished(
            pi,
            finalDetails,
            {
              finalText: result.finalText,
              errorMessage: result.errorMessage,
              isError: result.isError,
            },
            currentModel,
          );
          emitWorkflowMessage(pi, "run-finished", snapshot);
        }

        return {
          content: [
            {
              type: "text",
              text: result.isError
                ? result.errorMessage || "(workflow failed)"
                : result.finalText,
            },
          ],
          details: finalDetails,
          isError: result.isError,
        };
      } catch (error) {
        const message = describeUnknownError(error);
        const fallbackDetails = tracker.previousDetails;
        if (fallbackDetails) {
          const failedDetails: WorkflowDetails = {
            ...fallbackDetails,
            state: {
              ...fallbackDetails.state,
              status: "failed",
              finishedAt: new Date().toISOString(),
            },
          };
          const snapshot = appendWorkflowRunFinished(
            pi,
            failedDetails,
            {
              finalText: "",
              errorMessage: message,
              isError: true,
            },
            currentModel,
          );
          emitWorkflowMessage(pi, "run-finished", snapshot);
          setWorkflowCardsWidget(
            ctx,
            buildWorkflowCardPayload(failedDetails, false, currentModel),
          );
        }
        throw error;
      }
    },

    renderCall(args, theme) {
      return buildWorkflowCallPreview(args.workflow, args.task, theme);
    },

    renderResult(result, options, theme) {
      return renderWorkflowResult(
        result as AgentToolResult<WorkflowDetails>,
        options.expanded,
        theme,
      );
    },
  });

  pi.registerCommand("workflow", {
    description:
      'Run a workflow. Examples: `/workflow "implement auth"` or `/workflow plan-build "implement auth"`.',
    getArgumentCompletions: (prefix) =>
      getWorkflowArgumentCompletions(commandCompletionCwd, prefix),
    handler: async (args, ctx) => {
      updateCommandCompletionCwd(ctx.cwd);
      const resolved = await resolveWorkflowCommandInput(args, ctx);
      if (!resolved) return;

      const { workflowName, task } = resolved;
      const instruction = buildConductorInstruction(workflowName, task);

      await ctx.waitForIdle();
      ctx.ui.setToolsExpanded(true);
      pi.sendUserMessage(instruction);
      await ctx.waitForIdle();
    },
  });
}

export {
  clearWorkflowRuntimeHooks,
  resolveWorkflowRuntimeHooks,
  setWorkflowRuntimeHooks,
  setWorkflowRuntimeHooksProvider,
};
export type { WorkflowRuntimeHookContext, WorkflowRuntimeHooks, WorkflowRuntimeHooksProvider };
