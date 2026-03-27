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
  type WorkflowCardPayload,
  buildWorkflowCardPayload,
  renderWorkflowCardLines,
} from "./workflow-cards.js";

const COLLAPSED_ITEM_COUNT = 10;
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ZELLIJ_PANE_SCRIPT = path.join(PACKAGE_ROOT, "scripts", "workflow-pane.mjs");

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

function setWorkflowCardsWidget(
  ctx: ExtensionContext,
  payload: WorkflowCardPayload | undefined,
) {
  if (!payload || !ctx.hasUI) return;

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

function blockMainSessionInput(ctx: ExtensionCommandContext): () => void {
  if (!ctx.hasUI) return () => {};

  const restoreInput = ctx.ui.onTerminalInput(() => ({ consume: true }));
  ctx.ui.setWorkingMessage("Workflow running in Zellij. Input is blocked until it finishes.");

  return () => {
    restoreInput();
    ctx.ui.setWorkingMessage();
  };
}

function buildMainSessionSummary(
  workflowName: string,
  status: {
    success: boolean;
    message?: string;
    summary?: string;
    closedByUser?: boolean;
  },
): { text: string; type: "info" | "warning" | "error" } {
  const summary = status.summary?.trim() || status.message?.trim();
  if (status.success) {
    return {
      text: summary
        ? `Workflow ${workflowName} finished.\n\n${summary}`
        : `Workflow ${workflowName} finished.`,
      type: "info",
    };
  }

  if (status.closedByUser) {
    return {
      text: summary
        ? `Workflow ${workflowName} pane was closed.\n\n${summary}`
        : `Workflow ${workflowName} pane was closed.`,
      type: "warning",
    };
  }

  return {
    text: summary
      ? `Workflow ${workflowName} failed.\n\n${summary}`
      : `Workflow ${workflowName} failed.`,
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
    successCount === details.results.length
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
        theme.fg(
          "muted",
          `decisions:${shared.decisions.length} learnings:${shared.learnings.length} blockers:${shared.blockers.length} verification:${shared.verification.length}`,
        ),
        0,
        0,
      ),
    );

    for (let index = 0; index < details.results.length; index++) {
      const step = details.results[index];
      const stateStep = details.state.steps[index];
      const stepIcon = isErrorResult(step)
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
    theme.fg(
      "muted",
      `decisions:${details.state.shared.decisions.length} learnings:${details.state.shared.learnings.length} blockers:${details.state.shared.blockers.length} verification:${details.state.shared.verification.length}`,
    );

  for (let index = 0; index < details.results.length; index++) {
    const step = details.results[index];
    const stateStep = details.state.steps[index];
    const stepIcon = isErrorResult(step)
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

export default function registerExtension(pi: ExtensionAPI) {
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
      const result = await runWorkflowByName(
        runtimeCwd,
        params.workflow,
        params.task,
        getCurrentModelLabel(ctx),
        signal,
        onUpdate
          ? (details) => {
              setWorkflowCardsWidget(
                ctx,
                buildWorkflowCardPayload(details, true, getCurrentModelLabel(ctx)),
              );
              onUpdate({
                content: [
                  {
                    type: "text",
                    text: details.results.length > 0
                      ? details.results[details.results.length - 1].lastWork || "(running...)"
                      : "(running...)",
                  },
                ],
                details,
              });
            }
          : undefined,
      );
      if (result.steps.length > 0) {
        setWorkflowCardsWidget(
          ctx,
          buildWorkflowCardPayload(
            {
              workflowName: result.workflowName,
              steps: result.steps,
              workflowSource: result.workflowSource,
              workflowFilePath: result.workflowFilePath,
              results: result.results,
              state: result.state,
            },
            false,
            getCurrentModelLabel(ctx),
          ),
        );
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
        details: {
          workflowName: result.workflowName,
          steps: result.steps,
          workflowSource: result.workflowSource,
          workflowFilePath: result.workflowFilePath,
          results: result.results,
          state: result.state,
        },
        isError: result.isError,
      };
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
    handler: async (args, ctx) => {
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
            setWorkflowCardsWidget(ctx, {
              workflowName,
              summary: {
                decisions: 0,
                learnings: 0,
                blockers: 0,
                verification: 0,
              },
              steps: workflowConfig.steps.map((step) => ({
                agent: step.agent,
                objective: `Run ${step.agent}`,
                model: getCurrentModelLabel(ctx),
                status: "pending",
                elapsedMs: 0,
                lastWork: "",
              })),
            });
          }
          ctx.ui.setStatus("workflow", `Running ${workflowName} in Zellij...`);
          try {
            const status = await waitForWorkflowStatusFile(
              launched.statusFile,
              launched.progressFile,
              (payload) => setWorkflowCardsWidget(ctx, payload),
            );
            const summary = buildMainSessionSummary(workflowName, status);
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
}
