import type { Theme } from "@mariozechner/pi-coding-agent";
import type { WorkflowDetails } from "./workflow-runtime.js";
import {
  buildWorkflowPresentation,
  type WorkflowPresentationPayload,
  type WorkflowPresentationStep,
  type WorkflowPresentationStepStatus,
} from "./workflow-presentation.js";

export type WorkflowCardStatus = WorkflowPresentationStepStatus;
export type WorkflowCardState = WorkflowPresentationStep;
export type WorkflowCardPayload = WorkflowPresentationPayload;

export interface WorkflowCardRenderOptions {
  animationTick?: number;
}

type WorkflowOverviewStatus = WorkflowCardPayload["status"];

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

function getBorderStyle(
  status: WorkflowCardStatus,
  styler: Styler,
): (text: string) => string {
  switch (status) {
    case "running":
      return styler.highlight;
    case "done":
      return styler.success;
    case "error":
      return styler.error;
    default:
      return styler.dim;
  }
}

function getOverviewStatusIcon(
  status: WorkflowOverviewStatus,
  animationTick: number,
): string {
  switch (status) {
    case "running":
      return getSpinnerFrame(animationTick);
    case "done":
      return "✓";
    case "blocked":
    case "failed":
      return "✗";
    default:
      return "○";
  }
}

function getOverviewStatusStyle(
  status: WorkflowOverviewStatus,
  styler: Styler,
): (text: string) => string {
  switch (status) {
    case "running":
      return styler.highlight;
    case "done":
      return styler.success;
    case "blocked":
    case "failed":
      return styler.error;
    default:
      return styler.dim;
  }
}

function formatStatusLabel(
  state: WorkflowCardState,
  animationTick: number,
): string {
  const elapsed =
    state.status === "pending" ? "" : ` ${Math.max(0, Math.round(state.elapsedMs / 1000))}s`;
  const base =
    state.rawStatus === "failed"
      ? "FAILED"
      : state.rawStatus === "blocked"
        ? "BLOCKED"
        : state.status.toUpperCase();
  return `${getStatusIcon(state.status, animationTick)} ${base}${elapsed}`;
}

function formatOverviewStatusLabel(
  status: WorkflowOverviewStatus,
  animationTick: number,
): string {
  const label =
    status === "failed"
      ? "FAILED"
      : status === "blocked"
        ? "BLOCKED"
        : status.toUpperCase();
  return `${getOverviewStatusIcon(status, animationTick)} ${label}`;
}

function formatVerifyStatus(state: WorkflowCardState): string {
  const status = state.verifyStatus ?? "pending";
  const label =
    status === "passed"
      ? "passed"
      : status === "failed"
        ? "failed"
        : status === "skipped"
          ? "skipped"
          : "pending";
  return `${label} p:${state.passedCheckCount} f:${state.failedCheckCount} n:${state.notRunCheckCount}`;
}

function buildProgressRail(
  state: WorkflowCardState,
  width: number,
  styler: Styler,
  animationTick: number,
): string {
  const railWidth = Math.max(8, width);

  switch (state.status) {
    case "done":
      return styler.success("█".repeat(railWidth));
    case "error": {
      const completed = Math.max(2, Math.floor(railWidth * 0.45));
      return styler.error("█".repeat(completed) + "░".repeat(railWidth - completed));
    }
    case "running": {
      const frames = ["█", "▓", "▒"];
      const cells = new Array<string>(railWidth).fill("░");
      const head = Math.floor(animationTick / 150) % railWidth;
      cells[head] = frames[Math.floor(animationTick / 250) % frames.length];
      if (head > 0) cells[head - 1] = "▓";
      if (head > 1) cells[head - 2] = "▒";
      return styler.highlight(cells.join(""));
    }
    default:
      return styler.dim("·".repeat(railWidth));
  }
}

function buildOverviewSubline(payload: WorkflowCardPayload, width: number): string {
  const stepSummary =
    payload.currentStepNumber && payload.currentStepAgent
      ? `Step ${payload.currentStepNumber}/${payload.steps.length} ${displayName(payload.currentStepAgent)}`
      : `${payload.steps.length} step${payload.steps.length === 1 ? "" : "s"} queued`;
  const focus = payload.currentFocus?.trim()
    ? truncateText(payload.currentFocus.trim().replace(/\s+/g, " "), 30)
    : payload.topPendingWorkItem?.trim()
      ? truncateText(payload.topPendingWorkItem.trim().replace(/\s+/g, " "), 30)
      : "";

  const combined = focus ? `${stepSummary}  •  ${focus}` : stepSummary;
  return truncateText(combined, width);
}

function buildOverviewMetrics(payload: WorkflowCardPayload, width: number): string {
  return truncateText(
    `open ${payload.summary.openWorkItems}  done ${payload.summary.doneWorkItems}  blocked ${payload.summary.blockedWorkItems}  blockers ${payload.summary.blockers}  verify ${payload.summary.verification}`,
    width,
  );
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

function styleJustifiedLine(
  left: string,
  right: string,
  width: number,
  borderStyle: (text: string) => string,
  leftStyle: (text: string) => string = (text) => text,
  rightStyle: (text: string) => string = (text) => text,
): string {
  const needsGap = left && right ? 1 : 0;
  const safeRight = truncateText(right, width);
  const maxLeft = Math.max(0, width - safeRight.length - needsGap);
  const safeLeft = truncateText(left, maxLeft);
  const gapWidth = Math.max(needsGap, width - safeLeft.length - safeRight.length);

  return (
    borderStyle("│") +
    leftStyle(safeLeft) +
    " ".repeat(gapWidth) +
    rightStyle(safeRight) +
    borderStyle("│")
  );
}

function renderOverviewLine(
  left: string,
  right: string,
  width: number,
  leftStyle: (text: string) => string = (text) => text,
  rightStyle: (text: string) => string = (text) => text,
): string {
  const needsGap = left && right ? 1 : 0;
  const safeRight = truncateText(right, width);
  const maxLeft = Math.max(0, width - safeRight.length - needsGap);
  const safeLeft = truncateText(left, maxLeft);
  const gapWidth = Math.max(needsGap, width - safeLeft.length - safeRight.length);
  return leftStyle(safeLeft) + " ".repeat(gapWidth) + rightStyle(safeRight);
}

function renderCard(
  state: WorkflowCardState,
  columnWidth: number,
  styler: Styler,
  animationTick: number,
): string[] {
  const innerWidth = Math.max(18, columnWidth - 2);
  const cardBorder = getBorderStyle(state.status, styler);
  const title = truncateText(buildTitle(state.agent, state.model), innerWidth);
  const objective = state.objective.trim()
    ? truncateText(`goal: ${state.objective.trim().replace(/\s+/g, " ")}`, innerWidth - 1)
    : "goal: —";
  const profile = state.profile ? `profile: ${state.profile}` : "profile: —";
  const statusLabel = formatStatusLabel(state, animationTick);
  const verifyLabel = truncateText(
    `verify: ${state.verificationPhase} · ${formatVerifyStatus(state)}`,
    innerWidth - 1,
  );
  const verifySummary = state.verifySummary?.trim()
    ? truncateText(
        `verify summary: ${state.verifySummary.trim().replace(/\s+/g, " ")}`,
        innerWidth - 1,
      )
    : "verify summary: —";
  const pending = state.topPendingWorkItem?.trim()
    ? truncateText(`pending: ${state.topPendingWorkItem.trim().replace(/\s+/g, " ")}`, innerWidth - 1)
    : "pending: —";
  const focus = state.currentFocus?.trim()
    ? truncateText(`focus: ${state.currentFocus.trim().replace(/\s+/g, " ")}`, innerWidth - 1)
    : "focus: —";
  const lastWork = state.lastWork.trim()
    ? truncateText(state.lastWork.trim().replace(/\s+/g, " "), innerWidth - 1)
    : "—";
  const updateLabel = state.newItemCount > 0 ? `+${state.newItemCount} updates` : "";
  const repairLabel = state.repairAttempted ? "repair" : "";
  const rightMeta = repairLabel || updateLabel;
  const top = cardBorder(`╭${"─".repeat(innerWidth)}╮`);
  const bottom = cardBorder(`╰${"─".repeat(innerWidth)}╯`);

  return [
    top,
    styleJustifiedLine(
      ` STEP ${String(state.stepNumber).padStart(2, "0")}`,
      statusLabel,
      innerWidth,
      cardBorder,
      (text) => styler.dim(text),
      (text) => getStatusText(state.status, text, styler),
    ),
    stylePaddedLine(` ${styler.accent(styler.bold(title))}`, innerWidth, cardBorder),
    stylePaddedLine(
      ` ${buildProgressRail(state, innerWidth - 1, styler, animationTick)}`,
      innerWidth,
      cardBorder,
    ),
    stylePaddedLine(` ${styler.muted(objective)}`, innerWidth, cardBorder),
    styleJustifiedLine(
      ` ${truncateText(profile, innerWidth - 2)}`,
      rightMeta,
      innerWidth,
      cardBorder,
      (text) => styler.muted(text),
      (text) => (repairLabel ? styler.highlight(text) : styler.accent(text)),
    ),
    stylePaddedLine(` ${styler.muted(verifyLabel)}`, innerWidth, cardBorder),
    stylePaddedLine(
      ` ${verifySummary === "verify summary: —" ? styler.dim(verifySummary) : styler.muted(verifySummary)}`,
      innerWidth,
      cardBorder,
    ),
    stylePaddedLine(` ${state.currentFocus ? styler.muted(focus) : styler.dim(focus)}`, innerWidth, cardBorder),
    stylePaddedLine(` ${state.topPendingWorkItem ? styler.muted(pending) : styler.dim(pending)}`, innerWidth, cardBorder),
    stylePaddedLine(` ${styler.accent("latest")}`, innerWidth, cardBorder),
    stylePaddedLine(
      ` ${lastWork === "—" ? styler.dim(lastWork) : styler.muted(lastWork)}`,
      innerWidth,
      cardBorder,
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
    const connectorRow = Math.floor(cards[0].length / 2);

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

export function buildWorkflowCardPayload(
  details: WorkflowDetails,
  _isRunning: boolean,
  defaultModel?: string,
): WorkflowCardPayload {
  return buildWorkflowPresentation(details, defaultModel);
}

export function renderWorkflowCardLines(
  payload: WorkflowCardPayload,
  width: number,
  theme?: Theme,
  options?: WorkflowCardRenderOptions,
): string[] {
  const styler = theme ? createThemeStyler(theme) : createPlainStyler();
  const animationTick = options?.animationTick ?? 0;
  const statusStyle = getOverviewStatusStyle(payload.status, styler);
  const statusLabel = formatOverviewStatusLabel(payload.status, animationTick);
  return [
    styler.dim("Workflow"),
    renderOverviewLine(
      payload.workflowName,
      statusLabel,
      width,
      (text) => styler.accent(styler.bold(text)),
      (text) => statusStyle(text),
    ),
    styler.muted(buildOverviewSubline(payload, width)),
    styler.dim(buildOverviewMetrics(payload, width)),
    "",
    ...renderRows(payload.steps, width, styler, animationTick),
  ];
}
