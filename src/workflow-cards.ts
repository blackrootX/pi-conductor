import type { Theme } from "@mariozechner/pi-coding-agent";
import type { WorkflowDetails } from "./workflow-runtime.js";

export type WorkflowCardStatus = "pending" | "running" | "done" | "error";

export interface WorkflowCardState {
  agent: string;
  status: WorkflowCardStatus;
  elapsedMs: number;
  lastWork: string;
}

export interface WorkflowCardPayload {
  workflowName: string;
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
};

function createThemeStyler(theme: Theme): Styler {
  return {
    accent: (text) => theme.fg("accent", text),
    bold: (text) => theme.bold(text),
    dim: (text) => theme.fg("dim", text),
    muted: (text) => theme.fg("muted", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
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

type BorderFrame = {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  style: (text: string) => string;
};

function getBorderFrame(
  status: WorkflowCardStatus,
  animationTick: number,
  styler: Styler,
): BorderFrame {
  if (status !== "running") {
    return {
      topLeft: "┌",
      topRight: "┐",
      bottomLeft: "└",
      bottomRight: "┘",
      horizontal: "─",
      vertical: "│",
      style: styler.dim,
    };
  }

  const frames: BorderFrame[] = [
    {
      topLeft: "┏",
      topRight: "┓",
      bottomLeft: "┗",
      bottomRight: "┛",
      horizontal: "━",
      vertical: "┃",
      style: styler.accent,
    },
    {
      topLeft: "╔",
      topRight: "╗",
      bottomLeft: "╚",
      bottomRight: "╝",
      horizontal: "═",
      vertical: "║",
      style: styler.accent,
    },
    {
      topLeft: "┍",
      topRight: "┑",
      bottomLeft: "┕",
      bottomRight: "┙",
      horizontal: "━",
      vertical: "│",
      style: styler.accent,
    },
    {
      topLeft: "╓",
      topRight: "╖",
      bottomLeft: "╙",
      bottomRight: "╜",
      horizontal: "─",
      vertical: "║",
      style: styler.accent,
    },
  ];

  return frames[Math.floor(animationTick / 250) % frames.length];
}

function renderCard(
  state: WorkflowCardState,
  columnWidth: number,
  styler: Styler,
  animationTick: number,
): string[] {
  const innerWidth = Math.max(12, columnWidth - 2);
  const name = truncateText(displayName(state.agent), innerWidth - 1);
  const elapsed =
    state.status === "pending" ? "" : ` ${Math.max(0, Math.round(state.elapsedMs / 1000))}s`;
  const statusLabel = `${getStatusIcon(state.status)} ${state.status}${elapsed}`;
  const lastWork = state.lastWork.trim()
    ? truncateText(state.lastWork.trim().replace(/\s+/g, " "), innerWidth - 1)
    : "—";

  const border = getBorderFrame(state.status, animationTick, styler);
  const top = border.style(
    `${border.topLeft}${border.horizontal.repeat(innerWidth)}${border.topRight}`,
  );
  const bottom = border.style(
    `${border.bottomLeft}${border.horizontal.repeat(innerWidth)}${border.bottomRight}`,
  );
  const lines = [
    stylePaddedLine(
      ` ${styler.accent(styler.bold(name))}`,
      innerWidth,
      border.vertical,
      border.style,
    ),
    stylePaddedLine(
      ` ${getStatusText(state.status, statusLabel, styler)}`,
      innerWidth,
      border.vertical,
      border.style,
    ),
    stylePaddedLine(
      ` ${lastWork === "—" ? styler.dim(lastWork) : styler.muted(lastWork)}`,
      innerWidth,
      border.vertical,
      border.style,
    ),
  ];

  return [top, ...lines, bottom];
}

function stylePaddedLine(
  content: string,
  width: number,
  vertical: string,
  borderStyle: (text: string) => string,
): string {
  const visibleContent = stripAnsi(content);
  return (
    borderStyle(vertical) +
    content +
    " ".repeat(Math.max(0, width - visibleContent.length)) +
    borderStyle(vertical)
  );
}

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

function getStatusIcon(status: WorkflowCardStatus): string {
  switch (status) {
    case "running":
      return "●";
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

function renderRows(
  steps: WorkflowCardState[],
  width: number,
  styler: Styler,
  animationTick: number,
): string[] {
  if (steps.length === 0) return [styler.dim("No workflow steps yet.")];

  const arrowWidth = 5;
  const minCardWidth = 18;
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
    const cards = chunk.map((step) =>
      renderCard(step, cardWidth, styler, animationTick),
    );
    const connectorRow = 2;

    for (let line = 0; line < cards[0].length; line++) {
      let row = cards[0][line];
      for (let cardIndex = 1; cardIndex < cards.length; cardIndex++) {
        row += line === connectorRow ? styler.dim(" ──▶ ") : " ".repeat(arrowWidth);
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
  isRunning: boolean,
): WorkflowCardPayload {
  const steps = details.agentNames.map((agentName, index) => {
    const result = details.results.find((item) => item.step === index + 1);
    if (!result) {
      return {
        agent: agentName,
        status: "pending" as const,
        elapsedMs: 0,
        lastWork: "",
      };
    }

    const isLatestResult = details.results[details.results.length - 1]?.step === result.step;
    const status: WorkflowCardStatus =
      result.exitCode !== 0 || result.stopReason === "error" || result.stopReason === "aborted"
        ? "error"
        : isRunning && isLatestResult
          ? "running"
          : "done";

    return {
      agent: agentName,
      status,
      elapsedMs: result.elapsedMs ?? 0,
      lastWork: result.lastWork ?? "",
    };
  });

  return {
    workflowName: details.workflowName,
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
    "",
    ...renderRows(payload.steps, width, styler, animationTick),
  ];
}
