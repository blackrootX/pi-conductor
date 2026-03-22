import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getMarkdownTheme,
} from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  type AgentConfig,
  type AgentSource,
  discoverAgents,
} from "./agents.js";
import {
  DEFAULT_WORKFLOW_NAME,
  type WorkflowConfig,
  type WorkflowSource,
  discoverWorkflows,
} from "./workflows.js";

const COLLAPSED_ITEM_COUNT = 10;

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

interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

interface SingleResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  task: string;
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

interface WorkflowDetails {
  workflowName: string;
  workflowSource: WorkflowSource;
  workflowFilePath: string | null;
  results: SingleResult[];
}

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

type OnUpdateCallback = (partial: AgentToolResult<WorkflowDetails>) => void;

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

function getFinalOutput(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    for (const part of msg.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
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

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tempDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tempDir, filePath };
}

function isErrorResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted"
  );
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  cwd: string | undefined,
  step: number,
  signal: AbortSignal | undefined,
  onUpdate: OnUpdateCallback | undefined,
  makeDetails: (results: SingleResult[]) => WorkflowDetails,
): Promise<SingleResult> {
  const agent = agents.find((item) => item.name === agentName);
  if (!agent) {
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}"`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  let tempPromptDir: string | null = null;
  let tempPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    if (!onUpdate) return;
    onUpdate({
      content: [
        {
          type: "text",
          text: getFinalOutput(currentResult.messages) || "(running...)",
        },
      ],
      details: makeDetails([currentResult]),
    });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tempPrompt = writePromptToTempFile(agent.name, agent.systemPrompt);
      tempPromptDir = tempPrompt.dir;
      tempPromptPath = tempPrompt.filePath;
      args.push("--append-system-prompt", tempPromptPath);
    }

    args.push(task);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: cwd ?? defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
          currentResult.messages.push(message);

          if (message.role === "assistant") {
            currentResult.usage.turns++;
            const usage = message.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && message.model) {
              currentResult.model = message.model;
            }
            if (message.stopReason) {
              currentResult.stopReason = message.stopReason;
            }
            if (message.errorMessage) {
              currentResult.errorMessage = message.errorMessage;
            }
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    if (wasAborted) throw new Error("Workflow step was aborted");
    return currentResult;
  } finally {
    if (tempPromptPath) {
      try {
        fs.unlinkSync(tempPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tempPromptDir) {
      try {
        fs.rmdirSync(tempPromptDir);
      } catch {
        /* ignore */
      }
    }
  }
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
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

async function launchWorkflowInZellijPane(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  workflowName: string,
  task: string,
): Promise<boolean> {
  const instruction = buildConductorInstruction(workflowName, task);
  const paneName = `workflow:${workflowName}`;
  const script = [
    `pi --no-session -p ${shellQuote(instruction)}`,
    "status=$?",
    "printf '\\n\\n[workflow finished with exit code %s] Press Enter to close this pane.' \"$status\"",
    "read -r _",
  ].join("; ");

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
        "bash",
        "-lc",
        script,
      ],
      { cwd: ctx.cwd },
    );
    ctx.ui.notify(`Opened workflow in Zellij pane: ${workflowName}`, "info");
    return true;
  } catch {
    return false;
  }
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

    for (const step of details.results) {
      const stepIcon = isErrorResult(step)
        ? theme.fg("error", "✗")
        : theme.fg("success", "✓");
      const displayItems = getDisplayItems(step.messages);
      const finalOutput = getFinalOutput(step.messages);

      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          `${theme.fg("muted", `─── Step ${step.step}: `)}${theme.fg("accent", step.agent)}${theme.fg("muted", ` (${step.agentSource}) `)}${stepIcon}`,
          0,
          0,
        ),
      );
      container.addChild(
        new Text(theme.fg("muted", "Input: ") + theme.fg("dim", step.task), 0, 0),
      );

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

  for (const step of details.results) {
    const stepIcon = isErrorResult(step)
      ? theme.fg("error", "✗")
      : theme.fg("success", "✓");
    const displayItems = getDisplayItems(step.messages);
    text += `\n\n${theme.fg("muted", `─── Step ${step.step}: `)}${theme.fg("accent", step.agent)}${theme.fg("muted", ` (${step.agentSource}) `)}${stepIcon}`;
    if (displayItems.length === 0) {
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
      const { agents } = discoverAgents(runtimeCwd);
      const { workflows } = discoverWorkflows(runtimeCwd);
      const workflow = workflows.find((item) => item.name === params.workflow);

      if (!workflow) {
        return {
          content: [
            {
              type: "text",
              text: `Unknown workflow: "${params.workflow}". Available workflows: ${buildAvailableWorkflowText(workflows) || "none"}.`,
            },
          ],
          details: {
            workflowName: params.workflow,
            workflowSource: "built-in" as const,
            workflowFilePath: null,
            results: [],
          },
          isError: true,
        };
      }

      const makeDetails = (results: SingleResult[]): WorkflowDetails => ({
        workflowName: workflow.name,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        results,
      });

      const missingAgents = workflow.agentNames.filter(
        (agentName) => !agents.some((agent) => agent.name === agentName),
      );
      if (missingAgents.length > 0) {
        return {
          content: [
            {
              type: "text",
              text: `Workflow "${workflow.name}" cannot start. Missing agents: ${missingAgents.join(", ")}.`,
            },
          ],
          details: makeDetails([]),
          isError: true,
        };
      }

      const results: SingleResult[] = [];
      let currentInput = params.task;

      for (let index = 0; index < workflow.agentNames.length; index++) {
        const agentName = workflow.agentNames[index];
        const workflowUpdate: OnUpdateCallback | undefined = onUpdate
          ? (partial) => {
              const currentResult = partial.details?.results[0];
              if (!currentResult) return;
              onUpdate({
                content: partial.content,
                details: makeDetails([...results, currentResult]),
              });
            }
          : undefined;

        const result = await runSingleAgent(
          runtimeCwd,
          agents,
          agentName,
          currentInput,
          runtimeCwd,
          index + 1,
          signal,
          workflowUpdate,
          makeDetails,
        );
        results.push(result);

        if (isErrorResult(result)) {
          const errorMessage =
            result.errorMessage ||
            result.stderr ||
            getFinalOutput(result.messages) ||
            "(no output)";
          return {
            content: [
              {
                type: "text",
                text: `Workflow stopped at step ${index + 1} (${agentName}): ${errorMessage}`,
              },
            ],
            details: makeDetails(results),
            isError: true,
          };
        }

        currentInput = getFinalOutput(result.messages);
      }

      const finalText =
        results.length > 0
          ? getFinalOutput(results[results.length - 1].messages) || "(no output)"
          : "(no output)";

      return {
        content: [{ type: "text", text: finalText }],
        details: makeDetails(results),
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
        if (launched) return;
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
