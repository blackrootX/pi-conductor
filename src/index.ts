import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
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
import { discoverAgents } from "./agents.js";
import {
  buildTeamCardPayload,
  renderTeamCardLines,
  type TeamCardPayload,
} from "./team-cards.js";
import {
  runTeamByName,
  type TeamMemberResult,
  type TeamRunDetails,
} from "./team-runtime.js";
import type { TeamConfig } from "./teams.js";
import { DEFAULT_TEAM_NAME, discoverTeams } from "./teams.js";
import type { WorkflowConfig } from "./workflows.js";
import { DEFAULT_WORKFLOW_NAME, discoverWorkflows } from "./workflows.js";
import {
  type SingleResult,
  type WorkflowDetails,
  getFinalOutput,
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
import { formatProgressText } from "./workflow-presentation.js";
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
  getLatestWorkflowSelection,
  getLatestWorkflowSnapshot,
} from "./workflow-session-entries.js";
import type { WorkflowRuntimeHooks } from "./workflow-hooks.js";
import type { SharedState } from "./workflow-types.js";

const COLLAPSED_ITEM_COUNT = 10;
const TOOL_POLICY_ENV = "PI_CONDUCTOR_ENFORCE_TOOLS";
const ALLOWED_TOOLS_ENV = "PI_CONDUCTOR_ALLOWED_TOOLS";
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZELLIJ_PANE_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "workflow-pane.mjs");
const TEAM_PANE_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "team-pane.mjs");
const TEAM_WORKER_PANE_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "team-worker-pane.mjs");
const TEAM_STATUS_TIMEOUT_MS = 30 * 60 * 1000;

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

const TeamConductorParams = Type.Object({
  team: Type.String({
    description: "Name of the team to run",
  }),
  task: Type.String({
    description: "Runtime task input for the team",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for the team run",
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

function aggregateUsage(
  results: Array<{
    usage: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      cost: number;
      turns: number;
    };
  }>,
) {
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

function isInsideTmux(): boolean {
  return Boolean(process.env.TMUX);
}

function isInsideZellij(): boolean {
  return Boolean(
    process.env.ZELLIJ ||
      process.env.ZELLIJ_SESSION_NAME ||
      process.env.ZELLIJ_PANE_ID,
  );
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

function buildTeamConductorInstruction(teamName: string, task: string): string {
  return [
    "Use the `team-conductor` tool immediately.",
    `Run the team named "${teamName}".`,
    "Pass the following task exactly as the tool's `task` argument.",
    "",
    task,
  ].join("\n");
}

function getCurrentModelLabel(ctx: ExtensionContext): string | undefined {
  return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

async function launchWorkflowInZellijPane(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflowName: string,
  task: string,
): Promise<{ launched: boolean; progressFile?: string; statusFile?: string }> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-zellij-"));
  const statusFile = path.join(tempDir, "workflow-status.json");
  const progressFile = path.join(tempDir, "workflow-progress.json");
  const paneName = `workflow:${workflowName}`;

  try {
    await pi.exec(
      "zellij",
      [
        "run",
        "--direction",
        "right",
        "--name",
        paneName,
        "--cwd",
        ctx.cwd,
        "--",
        process.execPath,
        ZELLIJ_PANE_SCRIPT,
        "--workflow",
        workflowName,
        "--task",
        task,
        "--cwd",
        ctx.cwd,
        "--default-model",
        getCurrentModelLabel(ctx) ?? "",
        "--progress-file",
        progressFile,
        "--status-file",
        statusFile,
      ],
      { cwd: ctx.cwd },
    );
    return { launched: true, progressFile, statusFile };
  } catch {
    return { launched: false };
  }
}

async function launchTeamInTmuxPane(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  teamName: string,
  task: string,
): Promise<{
  launched: boolean;
  progressFile?: string;
  statusFile?: string;
  abortFile?: string;
}> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-tmux-"));
  const statusFile = path.join(tempDir, "team-status.json");
  const progressFile = path.join(tempDir, "team-progress.json");
  const abortFile = path.join(tempDir, "team-abort");

  try {
    await pi.exec(
      "tmux",
      [
        "split-window",
        "-h",
        "-d",
        "-c",
        ctx.cwd,
        process.execPath,
        TEAM_PANE_SCRIPT,
        "--team",
        teamName,
        "--task",
        task,
        "--cwd",
        ctx.cwd,
        "--default-model",
        getCurrentModelLabel(ctx) ?? "",
        "--progress-file",
        progressFile,
        "--status-file",
        statusFile,
        "--abort-file",
        abortFile,
      ],
      { cwd: ctx.cwd },
    );
    return { launched: true, progressFile, statusFile, abortFile };
  } catch {
    return { launched: false };
  }
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

function setTeamCardsWidget(
  ctx: ExtensionContext,
  payload: TeamCardPayload | undefined,
) {
  if (!payload || !ctx.hasUI) return;

  ctx.ui.setWidget(
    "team-cards",
    (_tui, theme) => {
      const text = new Text("", 0, 0);
      const isAnimated = payload.phases.some((phase) =>
        phase.members.some((member) => member.status === "running"),
      );
      const interval = isAnimated
        ? setInterval(() => {
            text.invalidate();
          }, 250)
        : undefined;

      return {
        render(width: number) {
          text.setText(
            renderTeamCardLines(payload, width, theme, {
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

function tryReadWorkflowCardPayload(progressFile: string): WorkflowCardPayload | undefined {
  try {
    const content = fs.readFileSync(progressFile, "utf8");
    return JSON.parse(content) as WorkflowCardPayload;
  } catch {
    return undefined;
  }
}

async function waitForWorkflowStatusFile(
  statusFile: string,
  progressFile: string | undefined,
  onProgress?: (payload: WorkflowCardPayload) => void,
): Promise<{
  success: boolean;
  message?: string;
  summary?: string;
  closedByUser?: boolean;
}> {
  let lastProgressContent = "";
  while (true) {
    if (progressFile) {
      try {
        const content = fs.readFileSync(progressFile, "utf8");
        if (content !== lastProgressContent) {
          lastProgressContent = content;
          onProgress?.(JSON.parse(content) as WorkflowCardPayload);
        }
      } catch {
        /* still waiting */
      }
    }

    try {
      const content = fs.readFileSync(statusFile, "utf8");
      const data = JSON.parse(content) as {
        done?: boolean;
        success?: boolean;
        message?: string;
        summary?: string;
        closedByUser?: boolean;
      };
      if (data.done) {
        return {
          success: Boolean(data.success),
          message: data.message,
          summary: data.summary,
          closedByUser: data.closedByUser,
        };
      }
    } catch {
      /* still waiting */
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
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

async function waitForTeamStatusFile(
  statusFile: string,
  progressFile: string | undefined,
  onProgress?: (payload: TeamCardPayload) => void,
): Promise<{
  success: boolean;
  message?: string;
  summary?: string;
  closedByUser?: boolean;
}> {
  const startedAt = Date.now();
  let lastProgressContent = "";

  while (true) {
    if (progressFile) {
      try {
        const content = fs.readFileSync(progressFile, "utf8");
        if (content !== lastProgressContent) {
          lastProgressContent = content;
          onProgress?.(JSON.parse(content) as TeamCardPayload);
        }
      } catch {
        /* still waiting */
      }
    }

    try {
      const content = fs.readFileSync(statusFile, "utf8");
      const data = JSON.parse(content) as {
        done?: boolean;
        success?: boolean;
        message?: string;
        summary?: string;
        closedByUser?: boolean;
      };
      if (data.done) {
        return {
          success: Boolean(data.success),
          message: data.message,
          summary: data.summary,
          closedByUser: data.closedByUser,
        };
      }
    } catch {
      /* still waiting */
    }

    if (Date.now() - startedAt >= TEAM_STATUS_TIMEOUT_MS) {
      console.error("Team run timed out waiting for pane status");
      return {
        success: false,
        message: "Team run timed out waiting for pane status.",
        summary: "Team run timed out waiting for pane status.",
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function blockMainSessionInput(ctx: ExtensionCommandContext): () => void {
  if (!ctx.hasUI) return () => {};

  const restoreInput = ctx.ui.onTerminalInput(() => ({ consume: true }));
  ctx.ui.setWorkingMessage("Workflow running in Zellij. Input is blocked until it finishes.");

  return () => {
    restoreInput();
    ctx.ui.setWorkingMessage();
  };
}

function blockTeamMainSessionInput(
  ctx: ExtensionCommandContext,
  abortFile: string,
): () => void {
  if (!ctx.hasUI) return () => {};

  let abortRequested = false;
  const restoreInput = ctx.ui.onTerminalInput((data) => {
    if (data === "\u0003" && !abortRequested) {
      abortRequested = true;
      try {
        fs.writeFileSync(abortFile, "", "utf8");
      } catch {
        /* ignore */
      }
      ctx.ui.notify("Abort requested. Waiting for the team pane to stop workers...", "warning");
      return { consume: true };
    }
    return { consume: true };
  });
  ctx.ui.setWorkingMessage("Team running in tmux. Input is blocked; press Ctrl+C to abort.");

  return () => {
    restoreInput();
    ctx.ui.setWorkingMessage();
  };
}

function blockTeamRunInput(
  ctx: ExtensionCommandContext,
  abortRun: () => void,
): () => void {
  if (!ctx.hasUI) return () => {};

  let abortRequested = false;
  const restoreInput = ctx.ui.onTerminalInput((data) => {
    if (data === "\u0003" && !abortRequested) {
      abortRequested = true;
      abortRun();
      ctx.ui.notify("Abort requested. Waiting for team workers to stop...", "warning");
      return { consume: true };
    }
    return { consume: true };
  });
  ctx.ui.setWorkingMessage("Team running. Input is blocked; press Ctrl+C to abort.");

  return () => {
    restoreInput();
    ctx.ui.setWorkingMessage();
  };
}

function buildMainSessionSummary(
  noun: string,
  runName: string,
  status: {
    success: boolean;
    message?: string;
    summary?: string;
    closedByUser?: boolean;
  },
): { text: string; type: "info" | "warning" | "error" } {
  const summary = status.summary?.trim() || status.message?.trim();
  const title = `${noun} ${runName}`;
  if (status.success) {
    return {
      text: summary
        ? `${title} finished.\n\n${summary}`
        : `${title} finished.`,
      type: "info",
    };
  }

  if (status.closedByUser) {
    return {
      text: summary
        ? `${title} pane was closed.\n\n${summary}`
        : `${title} pane was closed.`,
      type: "warning",
    };
  }

  return {
    text: summary
      ? `${title} failed.\n\n${summary}`
      : `${title} failed.`,
    type: "error",
  };
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

function notifyDiscoveryWarnings(
  ctx: ExtensionCommandContext | ExtensionContext,
  warnings: string[],
) {
  if (!ctx.hasUI || warnings.length === 0) return;
  ctx.ui.notify(warnings.join("\n"), "warning");
}

async function resolveTeamCommandInput(
  args: string,
  ctx: ExtensionCommandContext,
): Promise<{ teamName: string; task: string } | undefined> {
  const { teams, warnings } = discoverTeams(ctx.cwd);
  notifyDiscoveryWarnings(ctx, warnings);

  const teamMap = new Map(teams.map((team) => [team.name, team]));
  const tokens = tokenizeCommandArgs(args.trim());

  if (tokens.length === 0) {
    if (!ctx.hasUI) {
      ctx.ui.notify(
        "Provide a team name and task when no interactive UI is available.",
        "error",
      );
      return undefined;
    }

    const options = teams.map((team) => `${team.name} (${team.source})`);
    const choice = await ctx.ui.select("Select team", options);
    if (!choice) return undefined;
    const index = options.indexOf(choice);
    const selected = teams[index];
    const task = await ctx.ui.input(`Run team: ${selected.name}`, "implement auth");
    if (!task?.trim()) return undefined;
    return { teamName: selected.name, task: task.trim() };
  }

  const maybeTeam = teamMap.get(tokens[0]);
  if (maybeTeam) {
    const remainingTask = tokens.slice(1).join(" ").trim();
    if (remainingTask) {
      return { teamName: maybeTeam.name, task: remainingTask };
    }
    if (!ctx.hasUI) {
      ctx.ui.notify("Provide a task after the team name.", "error");
      return undefined;
    }
    const task = await ctx.ui.input(`Run team: ${maybeTeam.name}`, "implement auth");
    if (!task?.trim()) return undefined;
    return { teamName: maybeTeam.name, task: task.trim() };
  }

  return {
    teamName: DEFAULT_TEAM_NAME,
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
      : details.state.status === "blocked"
        ? theme.fg("warning", "!")
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
    if (details.state.status === "blocked") {
      container.addChild(
        new Text(theme.fg("warning", "Reply with clarification to continue."), 0, 0),
      );
    }

    for (let index = 0; index < details.results.length; index++) {
      const step = details.results[index];
      const stateStep = details.state.steps[index];
      const stepIcon = stateStep?.status === "blocked"
        ? theme.fg("warning", "!")
        : isErrorResult(step) || stateStep?.status === "failed"
          ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
      const displayItems = getDisplayItems(step.messages);
      const finalOutput = formatProgressText(
        step.lastWork ||
          stateStep?.result?.summary ||
          step.repairedFinalText ||
          step.rawFinalText ||
          getFinalOutput(step.messages),
      );

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
  if (details.state.status === "blocked") {
    text += `\n${theme.fg("warning", "Reply with clarification to continue.")}`;
  }

	  for (let index = 0; index < details.results.length; index++) {
    const step = details.results[index];
    const stateStep = details.state.steps[index];
    const stepIcon = stateStep?.status === "blocked"
      ? theme.fg("warning", "!")
      : isErrorResult(step) || stateStep?.status === "failed"
        ? theme.fg("error", "✗")
      : theme.fg("success", "✓");
    const displayItems = getDisplayItems(step.messages);
    const finalOutput = formatProgressText(
      step.lastWork ||
        stateStep?.result?.summary ||
        step.repairedFinalText ||
        step.rawFinalText ||
        getFinalOutput(step.messages),
    );
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

function buildInitialTeamCardPayload(
  cwd: string,
  teamConfig: TeamConfig,
  defaultModel: string | undefined,
): TeamCardPayload {
  const { agents } = discoverAgents(cwd);
  return {
    teamName: teamConfig.name,
    phases: teamConfig.phases.map((phase) => ({
      kind: phase.kind,
      warningMessage: undefined,
      members: phase.agentNames.map((agentName) => {
        const agent = agents.find((item) => item.name === agentName);
        return {
          agent: agentName,
          model: agent?.model ?? defaultModel,
          status: "pending" as const,
          elapsedMs: 0,
          lastWork: "",
        };
      }),
    })),
  };
}

interface TeamWorkerPaneState {
  title: string;
  teamName: string;
  slotIndex: number;
  phaseIndex: number | null;
  phaseKind?: "parallel" | "sequential";
  agent?: string;
  model?: string;
  status: "idle" | "pending" | "running" | "done" | "error";
  elapsedMs: number;
  lastWork: string;
  input: string;
  finalMessage?: string;
  done?: boolean;
}

function getMaxParallelMembers(teamConfig: TeamConfig): number {
  return Math.max(
    1,
    ...teamConfig.phases.map((phase) =>
      phase.kind === "parallel" ? phase.agentNames.length : 1,
    ),
  );
}

function getActiveTeamPhaseIndex(details: TeamRunDetails): number {
  const runningIndex = details.phases.findIndex((phase) =>
    phase.members.some((member) => member.status === "running"),
  );
  if (runningIndex >= 0) return runningIndex;

  for (let index = details.phases.length - 1; index >= 0; index--) {
    const phase = details.phases[index];
    if (phase.members.some((member) => member.status !== "pending")) return index;
  }

  return 0;
}

function findTeamMemberResult(
  details: TeamRunDetails,
  phaseIndex: number,
  memberIndex: number,
): TeamMemberResult | undefined {
  return details.results.find(
    (resultItem) =>
      resultItem.phaseIndex === phaseIndex && resultItem.memberIndex === memberIndex,
  );
}

function buildTeamWorkerPaneStates(
  details: TeamRunDetails,
  totalSlots: number,
  finalMessage?: string,
  done?: boolean,
): TeamWorkerPaneState[] {
  const activePhaseIndex = getActiveTeamPhaseIndex(details);
  const activePhase = details.phases[activePhaseIndex];

  return Array.from({ length: totalSlots }, (_, slotIndex) => {
    if (slotIndex >= activePhase.members.length) {
      return {
        title: `${details.teamName} worker ${slotIndex + 1}`,
        teamName: details.teamName,
        slotIndex,
        phaseIndex: null,
        status: done ? "idle" : "pending",
        elapsedMs: 0,
        lastWork: "",
        input: "",
        finalMessage,
        done,
      };
    }

    const memberState = activePhase.members[slotIndex];
    const memberResult = findTeamMemberResult(details, activePhaseIndex, slotIndex);

    return {
      title: `${details.teamName} worker ${slotIndex + 1}`,
      teamName: details.teamName,
      slotIndex,
      phaseIndex: activePhaseIndex,
      phaseKind: activePhase.kind,
      agent: memberState.agent,
      model: memberState.model,
      status: memberState.status,
      elapsedMs: memberState.elapsedMs,
      lastWork: memberResult?.lastWork || memberState.lastWork,
      input: memberResult?.task || "",
      finalMessage,
      done,
    };
  });
}

function writeTeamWorkerPaneStates(
  stateFiles: string[],
  details: TeamRunDetails,
  finalMessage?: string,
  done?: boolean,
) {
  const states = buildTeamWorkerPaneStates(details, stateFiles.length, finalMessage, done);
  for (let index = 0; index < stateFiles.length; index++) {
    fs.writeFileSync(stateFiles[index], JSON.stringify(states[index]), "utf8");
  }
}

async function launchTeamWorkerPanes(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  teamName: string,
  stateFiles: string[],
): Promise<boolean> {
  try {
    const mainPaneId = (await pi.exec(
      "tmux",
      ["display-message", "-p", "#{pane_id}"],
      { cwd: ctx.cwd },
    )).stdout.trim();

    if (!mainPaneId) return false;

    const workerPaneIds: string[] = [];

    for (let index = 0; index < stateFiles.length; index++) {
      const targetPane = workerPaneIds[workerPaneIds.length - 1] ?? mainPaneId;
      const args =
        index === 0
          ? [
              "split-window",
              "-h",
              "-d",
              "-p",
              "50",
              "-t",
              targetPane,
              "-c",
              ctx.cwd,
              "-P",
              "-F",
              "#{pane_id}",
              process.execPath,
              TEAM_WORKER_PANE_SCRIPT,
              "--state-file",
              stateFiles[index],
              "--title",
              `${teamName} worker ${index + 1}`,
            ]
          : [
              "split-window",
              "-v",
              "-d",
              "-t",
              targetPane,
              "-c",
              ctx.cwd,
              "-P",
              "-F",
              "#{pane_id}",
              process.execPath,
              TEAM_WORKER_PANE_SCRIPT,
              "--state-file",
              stateFiles[index],
              "--title",
              `${teamName} worker ${index + 1}`,
            ];

      const result = await pi.exec(
        "tmux",
        args,
        { cwd: ctx.cwd },
      );
      const paneId = result.stdout.trim();
      if (paneId) workerPaneIds.push(paneId);
    }

    await pi.exec(
      "tmux",
      ["set-window-option", "-t", mainPaneId, "main-pane-width", "50%"],
      { cwd: ctx.cwd },
    );
    await pi.exec(
      "tmux",
      ["select-layout", "-t", mainPaneId, "main-vertical"],
      { cwd: ctx.cwd },
    );
    return true;
  } catch {
    return false;
  }
}

function renderTeamResult(
  result: AgentToolResult<TeamRunDetails>,
  expanded: boolean,
  theme: any,
) {
  const details = result.details;
  if (!details || details.phases.length === 0) {
    const text = result.content[0];
    return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
  }

  if (!expanded) {
    return new Text(
      renderTeamCardLines(buildTeamCardPayload(details), 100, theme, {
        animationTick: Date.now(),
      }).join("\n"),
      0,
      0,
    );
  }

  const mdTheme = getMarkdownTheme();
  const successCount = details.results.filter((item) => !item.errorMessage).length;
  const icon =
    successCount === details.results.length
      ? theme.fg("success", "✓")
      : theme.fg("error", "✗");

  const container = new Container();
  container.addChild(
    new Text(
      icon +
        " " +
        theme.fg("toolTitle", theme.bold("team ")) +
        theme.fg("accent", details.teamName) +
        theme.fg(
          "muted",
          ` (${details.teamSource}${details.teamFilePath ? `: ${details.teamFilePath}` : ""})`,
        ),
      0,
      0,
    ),
  );
  if (details.runDir) {
    container.addChild(new Text(theme.fg("dim", `Run artifacts: ${details.runDir}`), 0, 0));
  }

  for (let phaseIndex = 0; phaseIndex < details.phases.length; phaseIndex++) {
    const phase = details.phases[phaseIndex];
    container.addChild(new Spacer(1));
    container.addChild(
      new Text(
        `${theme.fg("muted", `─── Phase ${phaseIndex + 1}: `)}${theme.fg("accent", phase.kind)}`,
        0,
        0,
      ),
    );
    if (phase.warningMessage) {
      container.addChild(new Text(theme.fg("warning", `  ! ${phase.warningMessage}`), 0, 0));
    }

    for (let memberIndex = 0; memberIndex < phase.members.length; memberIndex++) {
      const member = phase.members[memberIndex];
      const memberResult = details.results.find(
        (resultItem) =>
          resultItem.phaseIndex === phaseIndex && resultItem.memberIndex === memberIndex,
      );
      const memberIcon =
        member.status === "error"
          ? theme.fg("error", "✗")
          : member.status === "done"
            ? theme.fg("success", "✓")
            : theme.fg("muted", "○");

      container.addChild(
        new Text(
          `${theme.fg("muted", "  • ")}${theme.fg("accent", member.agent)} ${memberIcon}`,
          0,
          0,
        ),
      );

      if (!memberResult) continue;

      container.addChild(
        new Text(
          theme.fg("muted", "    Input: ") + theme.fg("dim", memberResult.task),
          0,
          0,
        ),
      );

      const displayItems = getDisplayItems(memberResult.messages);
      for (const item of displayItems) {
        if (item.type !== "toolCall") continue;
        container.addChild(
          new Text(
            theme.fg("muted", "    → ") +
              formatToolCall(item.name, item.args, theme.fg.bind(theme)),
            0,
            0,
          ),
        );
      }

      const finalOutput = getFinalOutput(memberResult.messages);
      if (finalOutput) {
        container.addChild(new Spacer(1));
        container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
      }

      const usageText = formatUsageStats(memberResult.usage, memberResult.model);
      if (usageText) {
        container.addChild(new Text(theme.fg("dim", usageText), 0, 0));
      }
    }
  }

  const totalUsage = formatUsageStats(aggregateUsage(details.results));
  if (totalUsage) {
    container.addChild(new Spacer(1));
    container.addChild(new Text(theme.fg("dim", `Total: ${totalUsage}`), 0, 0));
  }

  return container;
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

function buildTeamCallPreview(teamName: string, task: string, theme: any) {
  const preview =
    task.length > 60 ? `${task.slice(0, 60)}...` : task || "(no task)";
  return new Text(
    theme.fg("toolTitle", theme.bold("team-conductor ")) +
      theme.fg("accent", teamName) +
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

  pi.registerTool({
    name: "team-conductor",
    label: "Team Conductor",
    description:
      "Run a named multi-phase team using agents discovered from project, global, and built-in definitions.",
    promptSnippet:
      "team-conductor(team, task): run a named team from .pi/team.yaml or ~/.pi/agent/team.yaml",
    promptGuidelines: [
      "Use `team-conductor` when the user wants to run a named team such as `plan-build-parallel`.",
      "Prefer `team-conductor` over manually recreating team phases yourself.",
    ],
    parameters: TeamConductorParams,

    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      const runtimeCwd = params.cwd ?? ctx.cwd;
      const { warnings } = discoverTeams(runtimeCwd);
      notifyDiscoveryWarnings(ctx, warnings);

      const result = await runTeamByName(
        runtimeCwd,
        params.team,
        params.task,
        getCurrentModelLabel(ctx),
        signal,
        onUpdate
          ? (details) => {
              setTeamCardsWidget(ctx, buildTeamCardPayload(details));
              onUpdate({
                content: [
                  {
                    type: "text",
                    text:
                      details.results.length > 0
                        ? details.results[details.results.length - 1].lastWork || "(running...)"
                        : "(running...)",
                  },
                ],
                details,
              });
            }
          : undefined,
        { sequentializeParallelPhases: !isInsideTmux() },
      );

      if (result.phases.length > 0) {
        setTeamCardsWidget(ctx, buildTeamCardPayload(result));
      }

      return {
        content: [
          {
            type: "text",
            text: result.isError ? result.errorMessage || "(team failed)" : result.finalText,
          },
        ],
        details: {
          teamName: result.teamName,
          teamSource: result.teamSource,
          teamFilePath: result.teamFilePath,
          runDir: result.runDir,
          phases: result.phases,
          results: result.results,
        },
        isError: result.isError,
      };
    },

    renderCall(args, theme) {
      return buildTeamCallPreview(args.team, args.task, theme);
    },

    renderResult(result, options, theme) {
      return renderTeamResult(
        result as AgentToolResult<TeamRunDetails>,
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

      if (isInsideZellij()) {
        const launched = await launchWorkflowInZellijPane(
          pi,
          ctx,
          workflowName,
          task,
        );
        if (launched.launched && launched.statusFile) {
          const unblockInput = blockMainSessionInput(ctx);
          const workflowConfig = discoverWorkflows(ctx.cwd).workflows.find(
            (workflow) => workflow.name === workflowName,
          );
          if (workflowConfig) {
            const initialDetails = createInitialWorkflowDetails(
              workflowConfig,
              task,
              randomUUID(),
            );
            setWorkflowCardsWidget(
              ctx,
              buildWorkflowCardPayload(
                initialDetails,
                true,
                getCurrentModelLabel(ctx),
              ),
            );
          }
          ctx.ui.setStatus("workflow", `Running ${workflowName} in Zellij...`);
          try {
            const status = await waitForWorkflowStatusFile(
              launched.statusFile,
              launched.progressFile,
              (payload) => setWorkflowCardsWidget(ctx, payload),
            );
            const summary = buildMainSessionSummary("Workflow", workflowName, status);
            ctx.ui.notify(summary.text, summary.type);
          } finally {
            ctx.ui.setStatus("workflow", undefined);
            unblockInput();
          }
          return;
        }
        ctx.ui.notify(
          "Could not open a Zellij pane. Running the workflow in the current Pi session instead.",
          "warning",
        );
      }
      await ctx.waitForIdle();
      ctx.ui.setToolsExpanded(true);
      pi.sendUserMessage(instruction);
      await ctx.waitForIdle();
    },
  });

  pi.registerCommand("team", {
    description:
      'Run a team. Examples: `/team "implement auth"` or `/team plan-build-parallel "implement auth"`.',
    handler: async (args, ctx) => {
      const resolved = await resolveTeamCommandInput(args, ctx);
      if (!resolved) return;

      const { teamName, task } = resolved;
      const instruction = buildTeamConductorInstruction(teamName, task);

      if (isInsideTmux()) {
        const { teams, warnings } = discoverTeams(ctx.cwd);
        notifyDiscoveryWarnings(ctx, warnings);
        const teamConfig = teams.find((team) => team.name === teamName);

        if (teamConfig) {
          const workerPaneTempDir = fs.mkdtempSync(
            path.join(os.tmpdir(), "pi-conductor-team-workers-"),
          );
          const workerCount = getMaxParallelMembers(teamConfig);
          const workerStateFiles = Array.from(
            { length: workerCount },
            (_, index) => path.join(workerPaneTempDir, `worker-${index + 1}.json`),
          );

          const initialPayload = buildInitialTeamCardPayload(
            ctx.cwd,
            teamConfig,
            getCurrentModelLabel(ctx),
          );
          setTeamCardsWidget(ctx, initialPayload);
          writeTeamWorkerPaneStates(
            workerStateFiles,
            {
              teamName,
              teamSource: teamConfig.source,
              teamFilePath: teamConfig.filePath ?? null,
              runDir: "",
              phases: initialPayload.phases,
              results: [],
            },
          );

          const launchedWorkerPanes = await launchTeamWorkerPanes(
            pi,
            ctx,
            teamName,
            workerStateFiles,
          );
          if (!launchedWorkerPanes) {
            ctx.ui.notify(
              "Could not open worker tmux panes. Running the team in the current session instead.",
              "warning",
            );
          }

          const abortController = new AbortController();
          const unblockInput = blockTeamRunInput(ctx, () => abortController.abort());
          ctx.ui.setStatus("team", `Running ${teamName} in tmux...`);

          try {
            const result = await runTeamByName(
              ctx.cwd,
              teamName,
              task,
              getCurrentModelLabel(ctx),
              abortController.signal,
              (details) => {
                setTeamCardsWidget(ctx, buildTeamCardPayload(details));
                writeTeamWorkerPaneStates(workerStateFiles, details);
              },
            );

            setTeamCardsWidget(ctx, buildTeamCardPayload(result));
            writeTeamWorkerPaneStates(
              workerStateFiles,
              result,
              result.isError ? result.errorMessage : result.finalText,
              true,
            );

            const summary = buildMainSessionSummary("Team", teamName, {
              success: !result.isError,
              message: result.isError ? result.errorMessage : result.finalText,
              summary: result.isError ? result.errorMessage : result.finalText,
            });
            ctx.ui.notify(summary.text, summary.type);
          } finally {
            ctx.ui.setStatus("team", undefined);
            unblockInput();
          }
          return;
        }

        ctx.ui.notify(
          "Could not resolve the requested team. Running the team in the current session instead.",
          "warning",
        );
      } else {
        ctx.ui.notify(
          "tmux not detected. Running team phases sequentially in the current session.",
          "warning",
        );
      }

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
