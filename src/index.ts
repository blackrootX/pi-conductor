import { randomUUID } from "node:crypto";
import * as os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionCommandContext,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import type { WorkflowConfig } from "./workflows.js";
import { DEFAULT_WORKFLOW_NAME, discoverWorkflows } from "./workflows.js";
import {
  type SingleResult,
  type WorkflowDetails,
  getFinalOutput,
  isErrorResult,
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
  getDoneWorkItems,
  projectWorkItems,
} from "./workflow-work-items.js";
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
  getLatestWorkflowSnapshot,
} from "./workflow-session-entries.js";
import type { WorkflowRuntimeHooks } from "./workflow-hooks.js";
import type { SharedState } from "./workflow-types.js";

const COLLAPSED_ITEM_COUNT = 10;
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

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

function formatUsageStats(
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    contextTokens?: number;
    turns?: number;
  },
  model?: string,
): string {
  const parts: string[] = [];
  if (usage.turns)
    parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
  if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  if (usage.contextTokens && usage.contextTokens > 0) {
    parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
  }
  if (model) parts.push(model);
  return parts.join(" ");
}

function formatToolCall(
  toolName: string,
  args: Record<string, unknown>,
  themeFg: (color: string, text: string) => string,
): string {
  const shortenPath = (filePath: string) => {
    const home = os.homedir();
    return filePath.startsWith(home)
      ? `~${filePath.slice(home.length)}`
      : filePath;
  };

  switch (toolName) {
    case "bash": {
      const command = (args.command as string) || "...";
      const preview =
        command.length > 60 ? `${command.slice(0, 60)}...` : command;
      return themeFg("muted", "$ ") + themeFg("toolOutput", preview);
    }
    case "read": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const offset = args.offset as number | undefined;
      const limit = args.limit as number | undefined;
      let text = themeFg("accent", filePath);
      if (offset !== undefined || limit !== undefined) {
        const startLine = offset ?? 1;
        const endLine = limit !== undefined ? startLine + limit - 1 : "";
        text += themeFg(
          "warning",
          `:${startLine}${endLine ? `-${endLine}` : ""}`,
        );
      }
      return themeFg("muted", "read ") + text;
    }
    case "write": {
      const rawPath = (args.file_path || args.path || "...") as string;
      const filePath = shortenPath(rawPath);
      const content = (args.content || "") as string;
      const lines = content.split("\n").length;
      let text = themeFg("muted", "write ") + themeFg("accent", filePath);
      if (lines > 1) text += themeFg("dim", ` (${lines} lines)`);
      return text;
    }
    case "edit": {
      const rawPath = (args.file_path || args.path || "...") as string;
      return (
        themeFg("muted", "edit ") + themeFg("accent", shortenPath(rawPath))
      );
    }
    case "ls": {
      const rawPath = (args.path || ".") as string;
      return themeFg("muted", "ls ") + themeFg("accent", shortenPath(rawPath));
    }
    case "find": {
      const pattern = (args.pattern || "*") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "find ") +
        themeFg("accent", pattern) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    case "grep": {
      const pattern = (args.pattern || "") as string;
      const rawPath = (args.path || ".") as string;
      return (
        themeFg("muted", "grep ") +
        themeFg("accent", `/${pattern}/`) +
        themeFg("dim", ` in ${shortenPath(rawPath)}`)
      );
    }
    default: {
      const argsStr = JSON.stringify(args);
      const preview =
        argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
      return themeFg("accent", toolName) + themeFg("dim", ` ${preview}`);
    }
  }
}

function getDisplayItems(messages: Message[]): DisplayItem[] {
  const items: DisplayItem[] = [];
  for (const msg of messages) {
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") {
        items.push({ type: "text", text: part.text });
      } else if (part.type === "toolCall") {
        items.push({
          type: "toolCall",
          name: part.name,
          args: part.arguments,
        });
      }
    }
  }
  return items;
}

function aggregateUsage(results: SingleResult[]) {
  const total = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    turns: 0,
  };
  for (const result of results) {
    total.input += result.usage.input;
    total.output += result.usage.output;
    total.cacheRead += result.usage.cacheRead;
    total.cacheWrite += result.usage.cacheWrite;
    total.cost += result.usage.cost;
    total.turns += result.usage.turns;
  }
  return total;
}

function buildSharedSummaryLine(shared: SharedState): string {
  const projection = projectWorkItems(shared.workItems);
  const readyCount = projection.ok ? projection.projection.readyWorkItems.length : 0;
  const blockedCount = projection.ok ? projection.projection.blockedWorkSummary.length : 0;
  return [
    `ready:${readyCount}`,
    `done:${getDoneWorkItems(shared.workItems).length}`,
    `blocked:${blockedCount}`,
    `blockers:${shared.blockers.length}`,
    `decisions:${shared.decisions.length}`,
    `learnings:${shared.learnings.length}`,
    `verification:${shared.verification.length}`,
  ].join(" ");
}

function getCurrentFocus(shared: SharedState): string | undefined {
  const projection = projectWorkItems(shared.workItems);
  return projection.ok ? projection.projection.currentFocus : undefined;
}

function getTopReadyWorkItem(shared: SharedState): string | undefined {
  const projection = projectWorkItems(shared.workItems);
  const item = projection.ok ? projection.projection.readyWorkItems[0] : undefined;
  if (!item) return undefined;
  const parts = [item.title, item.status];
  if (item.priority) parts.push(item.priority);
  return parts.join(" | ");
}

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

function renderDisplayItems(
  items: DisplayItem[],
  expanded: boolean,
  theme: { fg: (color: string, text: string) => string },
  limit?: number,
): string {
  const toShow = limit ? items.slice(-limit) : items;
  const skipped = limit && items.length > limit ? items.length - limit : 0;
  let text = "";
  if (skipped > 0) {
    text += theme.fg("muted", `... ${skipped} earlier items\n`);
  }
  for (const item of toShow) {
    if (item.type === "text") {
      const preview = expanded
        ? item.text
        : item.text.split("\n").slice(0, 3).join("\n");
      text += `${theme.fg("toolOutput", preview)}\n`;
    } else {
      text += `${theme.fg("muted", "→ ") + formatToolCall(item.name, item.args, theme.fg)}\n`;
    }
  }
  return text.trimEnd();
}

function buildWorkflowVerificationSummary(details: WorkflowDetails): string {
  const counts = { passed: 0, failed: 0, skipped: 0, pending: 0 };
  for (const step of details.state.steps) {
    const status = step.verifyStatus ?? "pending";
    if (status === "passed") counts.passed += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "skipped") counts.skipped += 1;
    else counts.pending += 1;
  }
  return `Verification: passed:${counts.passed} failed:${counts.failed} skipped:${counts.skipped} pending:${counts.pending}`;
}

function renderWorkflowResult(
  result: AgentToolResult<WorkflowDetails>,
  expanded: boolean,
  theme: any,
) {
  const details = result.details;
  if (!details || details.results.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  const mdTheme = getMarkdownTheme();
  const successCount = details.results.filter((item) => !isErrorResult(item))
    .length;
  const icon =
    details.state.status === "done" && successCount === details.results.length
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");

  if (expanded) {
    const container = new Container();
    container.addChild(
      new Text(
        icon +
          " " +
          theme.fg("toolTitle", theme.bold("workflow ")) +
          theme.fg("accent", details.workflowName) +
          theme.fg(
            "muted",
            ` (${details.workflowSource}${details.workflowFilePath ? `: ${details.workflowFilePath}` : ""})`,
          ),
        0,
        0,
      ),
    );

    const shared = details.state.shared;
    container.addChild(
      new Text(
        theme.fg("muted", buildSharedSummaryLine(shared)),
        0,
        0,
      ),
    );

    const currentFocus = getCurrentFocus(shared);
    if (currentFocus) {
      container.addChild(
        new Text(theme.fg("dim", `Focus: ${currentFocus}`), 0, 0),
      );
    }

    const topReadyWorkItem = getTopReadyWorkItem(shared);
    if (topReadyWorkItem) {
      container.addChild(
        new Text(theme.fg("dim", `Top ready: ${topReadyWorkItem}`), 0, 0),
      );
    }
    container.addChild(
      new Text(theme.fg("dim", buildWorkflowVerificationSummary(details)), 0, 0),
    );
    container.addChild(
      new Text(theme.fg("dim", `Run artifacts: ${details.runDir}`), 0, 0),
    );

    for (let index = 0; index < details.results.length; index++) {
      const step = details.results[index];
      const stateStep = details.state.steps[index];
      const stepIcon = isErrorResult(step) || stateStep?.status === "blocked" || stateStep?.status === "failed"
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
      const displayItems = getDisplayItems(step.messages);
      const finalOutput =
        step.lastWork ||
        stateStep?.result?.summary ||
        step.repairedFinalText ||
        step.rawFinalText ||
        getFinalOutput(step.messages);

      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${theme.fg("muted", `─── Step ${step.step}: `)}${theme.fg("accent", step.agent)}${theme.fg("muted", ` (${step.agentSource}) `)}${stepIcon}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(
          theme.fg("muted", "Objective: ") +
            theme.fg("dim", step.objective || stateStep?.objective || step.task),
          0,
          0,
        ),
      );
      if (stateStep?.profile) {
        container.addChild(
          new Text(theme.fg("dim", `Profile: ${stateStep.profile}`), 0, 0),
        );
      }
      container.addChild(
        new Text(
          theme.fg(
            "dim",
            `Verification: ${stateStep?.verifyStatus ?? "pending"} | phase: ${stateStep?.result ? "verified" : "provisional"} | p:${stateStep?.verifyChecks?.filter((item) => item.status === "pass").length ?? 0} f:${stateStep?.verifyChecks?.filter((item) => item.status === "fail").length ?? 0} n:${stateStep?.verifyChecks?.filter((item) => item.status === "not_run").length ?? 0}`,
          ),
          0,
          0,
        ),
      );
      if (stateStep?.verifySummary?.trim()) {
        container.addChild(
          new Text(theme.fg("dim", `Verify summary: ${stateStep.verifySummary.trim()}`), 0, 0),
        );
      }
      const newThisStep =
        (stateStep?.result?.decisions?.length ??
          stateStep?.provisionalResult?.decisions?.length ??
          0) +
        (stateStep?.result?.learnings?.length ??
          stateStep?.provisionalResult?.learnings?.length ??
          0) +
        (stateStep?.result?.blockers?.length ??
          stateStep?.provisionalResult?.blockers?.length ??
          0) +
        (stateStep?.result?.verification?.length ??
          stateStep?.provisionalResult?.verification?.length ??
          0);
      if (newThisStep > 0) {
        container.addChild(
          new Text(theme.fg("dim", `New this step: ${newThisStep}`), 0, 0),
        );
      }

      const stepFocus = stateStep?.result?.focusSummary?.trim();
      if (stepFocus) {
        container.addChild(
          new Text(theme.fg("dim", `Focus: ${stepFocus}`), 0, 0),
        );
      }

      if (step.parseError) {
        container.addChild(
          new Text(theme.fg("warning", `Parse repair: ${step.parseError}`), 0, 0),
        );
      }

      for (const item of displayItems) {
        if (item.type !== "toolCall") continue;
        container.addChild(
          new Text(
            theme.fg("muted", "→ ") +
              formatToolCall(item.name, item.args, theme.fg.bind(theme)),
            0,
            0,
          ),
        );
      }

      if (finalOutput) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
      } else if (displayItems.length === 0) {
        container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
      }

      const usageText = formatUsageStats(step.usage, step.model);
      if (usageText) {
        container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
      }
    }

    const totalUsage = formatUsageStats(aggregateUsage(details.results));
    if (totalUsage) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0),
      );
    }
    return container;
  }

  let text =
    icon +
    " " +
    theme.fg("toolTitle", theme.bold("workflow ")) +
    theme.fg("accent", details.workflowName) +
    theme.fg("muted", ` (${details.workflowSource})`);

  text +=
    "\n" +
    theme.fg("muted", buildSharedSummaryLine(details.state.shared));

  const currentFocus = getCurrentFocus(details.state.shared);
  if (currentFocus) {
    text += `\n${theme.fg("dim", `Focus: ${currentFocus}`)}`;
  }

  const topReadyWorkItem = getTopReadyWorkItem(details.state.shared);
  if (topReadyWorkItem) {
    text += `\n${theme.fg("dim", `Top ready: ${topReadyWorkItem}`)}`;
  }
  text += `\n${theme.fg("dim", buildWorkflowVerificationSummary(details))}`;
  text += `\n${theme.fg("dim", `Run artifacts: ${details.runDir}`)}`;

	  for (let index = 0; index < details.results.length; index++) {
    const step = details.results[index];
    const stateStep = details.state.steps[index];
    const stepIcon = isErrorResult(step) || stateStep?.status === "blocked" || stateStep?.status === "failed"
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");
    const displayItems = getDisplayItems(step.messages);
    const finalOutput =
      step.lastWork ||
      stateStep?.result?.summary ||
      step.repairedFinalText ||
      step.rawFinalText ||
      getFinalOutput(step.messages);
	    text += `\n\n${theme.fg("muted", `─── Step ${step.step}: `)}${theme.fg("accent", step.agent)}${theme.fg("muted", ` (${step.agentSource}) `)}${stepIcon}`;
	    text += `\n${theme.fg("muted", "Objective: ")}${theme.fg("dim", step.objective || stateStep?.objective || step.task)}`;
	    if (stateStep?.profile) {
	      text += `\n${theme.fg("dim", `Profile: ${stateStep.profile}`)}`;
	    }
	    text += `\n${theme.fg("dim", `Verification: ${stateStep?.verifyStatus ?? "pending"} | phase: ${stateStep?.result ? "verified" : "provisional"}`)}`;
	    if (stateStep?.verifySummary?.trim()) {
	      text += `\n${theme.fg("dim", `Verify summary: ${stateStep.verifySummary.trim()}`)}`;
	    }
	    if (stateStep?.result?.focusSummary?.trim()) {
	      text += `\n${theme.fg("dim", `Focus: ${stateStep.result.focusSummary.trim()}`)}`;
	    }
    if (step.parseError) {
      text += `\n${theme.fg("warning", `Parse repair: ${step.parseError}`)}`;
    }
    if (finalOutput) {
      text += `\n${theme.fg("toolOutput", finalOutput.trim())}`;
      const toolItems = displayItems.filter((item) => item.type === "toolCall");
      if (toolItems.length > 0) {
        text += `\n${renderDisplayItems(toolItems, false, theme, COLLAPSED_ITEM_COUNT)}`;
        if (toolItems.length > COLLAPSED_ITEM_COUNT) {
          text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
        }
      }
    } else if (displayItems.length === 0) {
      text += `\n${theme.fg("muted", "(no output)")}`;
    } else {
      text += `\n${renderDisplayItems(displayItems, false, theme, COLLAPSED_ITEM_COUNT)}`;
      if (displayItems.length > COLLAPSED_ITEM_COUNT) {
        text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
      }
    }
  }

  const totalUsage = formatUsageStats(aggregateUsage(details.results));
  if (totalUsage) {
    text += `\n\n${theme.fg("dim", `Total: ${totalUsage}`)}`;
  }
  return new Text(text, 0, 0);
}

function buildWorkflowCallPreview(workflowName: string, task: string, theme: any) {
  const preview =
    task.length > 60 ? `${task.slice(0, 60)}...` : task || "(no task)";
  return new Text(
    theme.fg("toolTitle", theme.bold("conductor ")) +
      theme.fg("accent", workflowName) +
      `\n  ${theme.fg("dim", preview)}`,
    0,
    0,
  );
}

function buildAvailableWorkflowText(workflows: WorkflowConfig[]): string {
  return workflows
    .map((workflow) => `${workflow.name} (${workflow.source})`)
    .join(", ");
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
