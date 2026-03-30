import * as os from "node:os";
import type { AgentToolResult } from "@mariozechner/pi-agent-core";
import type { Message } from "@mariozechner/pi-ai";
import { getMarkdownTheme } from "@mariozechner/pi-coding-agent";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { WorkflowConfig } from "./workflows.js";
import {
  type SingleResult,
  type WorkflowDetails,
  getFinalOutput,
  isErrorResult,
} from "./workflow-runtime.js";
import { formatProgressText } from "./workflow-presentation.js";
import {
  getDoneWorkItems,
  projectWorkItems,
} from "./workflow-work-items.js";
import type { SharedState } from "./workflow-types.js";

const COLLAPSED_ITEM_COUNT = 10;

type DisplayItem =
  | { type: "text"; text: string }
  | { type: "toolCall"; name: string; args: Record<string, unknown> };

function formatTokens(count: number): string {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(
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

export function aggregateUsage(results: SingleResult[]) {
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

export function buildSharedSummaryLine(shared: SharedState): string {
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

export function getCurrentFocus(shared: SharedState): string | undefined {
  const projection = projectWorkItems(shared.workItems);
  return projection.ok ? projection.projection.currentFocus : undefined;
}

export function getTopReadyWorkItem(shared: SharedState): string | undefined {
  const projection = projectWorkItems(shared.workItems);
  const item = projection.ok ? projection.projection.readyWorkItems[0] : undefined;
  if (!item) return undefined;
  const parts = [item.title, item.status];
  if (item.priority) parts.push(item.priority);
  return parts.join(" | ");
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

export function buildWorkflowVerificationSummary(details: WorkflowDetails): string {
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

export function renderWorkflowResult(
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

export function buildWorkflowCallPreview(workflowName: string, task: string, theme: any) {
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
