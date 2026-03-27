import type { Theme } from "@mariozechner/pi-coding-agent";
import {
  getBlockedWorkItems,
  getDoneWorkItems,
  getOpenWorkItems,
  getUnresolvedWorkItems,
} from "./workflow-work-items.js";
import type { WorkflowDetails } from "./workflow-runtime.js";

export type WorkflowCardStatus = "pending" | "running" | "done" | "error";

export interface WorkflowCardState {
  agent: string;
  objective: string;
  model?: string;
  status: WorkflowCardStatus;
  elapsedMs: number;
  lastWork: string;
  repairAttempted?: boolean;
  currentFocus?: string;
  topPendingWorkItem?: string;
}

export interface WorkflowCardPayload {
  workflowName: string;
  summary: {
    openWorkItems: number;
    doneWorkItems: number;
    blockedWorkItems: number;
    blockers: number;
    decisions: number;
    learnings: number;
    verification: number;
  };
  steps: WorkflowCardState[];
}

export interface WorkflowCardRenderOptions {
  animationTick?: number;
}

type Styler = {
  accent(text: string): string;
  bold(text: string): string;
  dim(text: string): string;
  muted(text: string): string;
  success(text: string): string;
  error(text: string): string;
  highlight(text: string): string;
};

function createThemeStyler(theme: Theme): Styler {
  return {
    accent: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    dim: (text) => theme.fg("dim", text),
    muted: (text) => theme.fg("muted", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
    highlight: (text) => theme.fg("warning", text),
  };
}

function createPlainStyler(): Styler {
  return {
    accent: (text) => text,
    bold: (text) => text,
    dim: (text) => text,
    muted: (text) => text,
    success: (text) => text,
    error: (text) => text,
    highlight: (text) => text,
  };
}

function displayName(name: string): string {
  return name
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function truncateText(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return "";
  if (text.length <= maxWidth) return text;
  if (maxWidth <= 3) return ".".repeat(maxWidth);
  return `${text.slice(0, maxWidth - 3)}...`;
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function formatModelLabel(model?: string): string {
  if (!model?.trim()) return "";
  const trimmed = model.trim();
  const slashIndex = trimmed.lastIndexOf("/");
  return slashIndex >= 0 ? trimmed.slice(slashIndex + 1) : trimmed;
}

function buildTitle(agent: string, model?: string): string {
  const name = displayName(agent);
  const label = formatModelLabel(model);
  return label ? `${name} - ${label}` : name;
}

function getSpinnerFrame(animationTick: number): string {
  const frames = ["◐", "◓", "◑", "◒"];
  return frames[Math.floor(animationTick / 250) % frames.length];
}

function getStatusIcon(status: WorkflowCardStatus, animationTick: number): string {
  switch (status) {
    case "running":
      return getSpinnerFrame(animationTick);
    case "done":
      return "✓";
    case "error":
      return "✗";
    default:
      return "○";
  }
}

function getStatusText(
  status: WorkflowCardStatus,
  text: string,
  styler: Styler,
): string {
  switch (status) {
    case "running":
      return styler.accent(text);
    case "done":
      return styler.success(text);
    case "error":
      return styler.error(text);
    default:
      return styler.dim(text);
  }
}

function stylePaddedLine(
  content: string,
  width: number,
  borderStyle: (text: string) => string,
): string {
  const visibleContent = stripAnsi(content);
  return (
    borderStyle("│") +
    content +
    " ".repeat(Math.max(0, width - visibleContent.length)) +
    borderStyle("│")
  );
}

function renderCard(
  state: WorkflowCardState,
  columnWidth: number,
  styler: Styler,
  animationTick: number,
): string[] {
  const innerWidth = Math.max(18, columnWidth - 2);
  const title = truncateText(buildTitle(state.agent, state.model), innerWidth - 1);
  const objective = state.objective.trim()
    ? truncateText(state.objective.trim().replace(/\s+/g, " "), innerWidth - 1)
    : "—";
  const focus = state.currentFocus?.trim()
    ? truncateText(`focus: ${state.currentFocus.trim().replace(/\s+/g, " ")}`, innerWidth - 1)
    : "focus: —";
  const elapsed =
    state.status === "pending" ? "" : ` ${Math.max(0, Math.round(state.elapsedMs / 1000))}s`;
  const repairLabel = state.repairAttempted ? " repair" : "";
  const statusLabel = `${getStatusIcon(state.status, animationTick)} ${state.status}${repairLabel}${elapsed}`;
  const pending = state.topPendingWorkItem?.trim()
    ? truncateText(`pending: ${state.topPendingWorkItem.trim().replace(/\s+/g, " ")}`, innerWidth - 1)
    : "pending: —";
  const lastWork = state.lastWork.trim()
    ? truncateText(state.lastWork.trim().replace(/\s+/g, " "), innerWidth - 1)
    : "—";

  const borderStyle = state.status === "running" ? styler.highlight : styler.dim;
  const top = borderStyle(`┌${"─".repeat(innerWidth)}┐`);
  const bottom = borderStyle(`└${"─".repeat(innerWidth)}┘`);

  return [
    top,
    stylePaddedLine(` ${styler.accent(styler.bold(title))}`, innerWidth, borderStyle),
    stylePaddedLine(` ${styler.muted(objective)}`, innerWidth, borderStyle),
    stylePaddedLine(` ${styler.muted(focus)}`, innerWidth, borderStyle),
    stylePaddedLine(` ${getStatusText(state.status, statusLabel, styler)}`, innerWidth, borderStyle),
    stylePaddedLine(` ${state.topPendingWorkItem ? styler.muted(pending) : styler.dim(pending)}`, innerWidth, borderStyle),
    stylePaddedLine(
      ` ${lastWork === "—" ? styler.dim(lastWork) : styler.muted(lastWork)}`,
      innerWidth,
      borderStyle,
    ),
    bottom,
  ];
}

function renderConnector(
  nextStep: WorkflowCardState,
  animationTick: number,
  styler: Styler,
): string {
  if (nextStep.status !== "running") return styler.dim(" ──▶ ");

  const frames = [" •──▶", " ─•─▶", " ──•▶", " ───▶"];
  return styler.highlight(frames[Math.floor(animationTick / 250) % frames.length]);
}

function renderRows(
  steps: WorkflowCardState[],
  width: number,
  styler: Styler,
  animationTick: number,
): string[] {
  if (steps.length === 0) return [styler.dim("No workflow steps yet.")];

  const arrowWidth = 5;
  const minCardWidth = 26;
  const cardsPerRow = Math.max(
    1,
    Math.min(
      steps.length,
      Math.floor((Math.max(width, minCardWidth) + arrowWidth) / (minCardWidth + arrowWidth)),
    ),
  );

  const chunks: WorkflowCardState[][] = [];
  for (let index = 0; index < steps.length; index += cardsPerRow) {
    chunks.push(steps.slice(index, index + cardsPerRow));
  }

  const output: string[] = [];
  for (const chunk of chunks) {
    const totalArrowWidth = arrowWidth * Math.max(0, chunk.length - 1);
    const cardWidth = Math.max(
      minCardWidth,
      Math.floor((Math.max(width, minCardWidth) - totalArrowWidth) / chunk.length),
    );
    const cards = chunk.map((step) => renderCard(step, cardWidth, styler, animationTick));
    const connectorRow = 4;

    for (let line = 0; line < cards[0].length; line++) {
      let row = cards[0][line];
      for (let cardIndex = 1; cardIndex < cards.length; cardIndex++) {
        row +=
          line === connectorRow
            ? renderConnector(chunk[cardIndex], animationTick, styler)
            : " ".repeat(arrowWidth);
        row += cards[cardIndex][line];
      }
      output.push(row);
    }

    if (chunk !== chunks[chunks.length - 1]) output.push("");
  }

  return output;
}

function deriveCurrentFocus(details: WorkflowDetails): string | undefined {
  const explicitFocus = details.state.shared.focus?.trim();
  if (explicitFocus) return explicitFocus;
  return getUnresolvedWorkItems(details.state.shared.workItems)[0]?.title;
}

function formatTopPendingWorkItem(details: WorkflowDetails): string | undefined {
  const item = getUnresolvedWorkItems(details.state.shared.workItems)[0];
  if (!item) return undefined;
  const parts = [item.title, item.status];
  if (item.priority) parts.push(item.priority);
  return parts.join(" | ");
}

export function buildWorkflowCardPayload(
  details: WorkflowDetails,
  _isRunning: boolean,
  defaultModel?: string,
): WorkflowCardPayload {
  const currentFocus = deriveCurrentFocus(details);
  const topPendingWorkItem = formatTopPendingWorkItem(details);

  const steps = details.steps.map((step, index) => {
    const result = details.results.find((item) => item.stepId === step.id || item.step === index + 1);
    const stateStep = details.state.steps[index];
    const stepStatus = stateStep?.status ?? "pending";
    const status: WorkflowCardStatus =
      stepStatus === "failed" || stepStatus === "blocked"
        ? "error"
        : stepStatus === "running"
          ? "running"
          : stepStatus === "done"
            ? "done"
            : "pending";

    return {
      agent: step.agent,
      objective: stateStep?.objective ?? `Run ${step.agent}`,
      model: result?.model ?? defaultModel,
      status,
      elapsedMs: result?.elapsedMs ?? 0,
      lastWork: result?.lastWork ?? stateStep?.result?.summary ?? "",
      repairAttempted: result?.repairAttempted,
      currentFocus,
      topPendingWorkItem,
    };
  });

  return {
    workflowName: details.workflowName,
    summary: {
      openWorkItems: getOpenWorkItems(details.state.shared.workItems).length,
      doneWorkItems: getDoneWorkItems(details.state.shared.workItems).length,
      blockedWorkItems: getBlockedWorkItems(details.state.shared.workItems).length,
      blockers: details.state.shared.blockers.length,
      decisions: details.state.shared.decisions.length,
      learnings: details.state.shared.learnings.length,
      verification: details.state.shared.verification.length,
    },
    steps,
  };
}

export function renderWorkflowCardLines(
  payload: WorkflowCardPayload,
  width: number,
  theme?: Theme,
  options?: WorkflowCardRenderOptions,
): string[] {
  const styler = theme ? createThemeStyler(theme) : createPlainStyler();
  const animationTick = options?.animationTick ?? 0;
  return [
    styler.dim("Workflow"),
    styler.accent(styler.bold(payload.workflowName)),
    styler.muted(
      `open:${payload.summary.openWorkItems} done:${payload.summary.doneWorkItems} blocked:${payload.summary.blockedWorkItems} blockers:${payload.summary.blockers} decisions:${payload.summary.decisions} learnings:${payload.summary.learnings} verification:${payload.summary.verification}`,
    ),
    "",
    ...renderRows(payload.steps, width, styler, animationTick),
  ];
}
