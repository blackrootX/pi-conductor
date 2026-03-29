import type { Theme } from "@mariozechner/pi-coding-agent";
import type { MeetingProgressUpdate, MeetingRunResult } from "./meeting-runtime.js";
import type { TeamRunDetails } from "./team-runtime.js";
import {
  buildTeamCardPayload,
  renderTeamCardLines,
  type TeamCardPayload,
} from "./team-cards.js";

export type { TeamCardPayload };

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

export interface MeetingCardPayload {
  meetingName: string;
  mode: "execute" | "refine" | "debate";
  executePayload?: TeamCardPayload;
  updates: MeetingProgressUpdate[];
  isFinished: boolean;
  isError: boolean;
  errorMessage?: string;
}

export function buildMeetingCardPayload(
  meetingName: string,
  mode: "execute" | "refine" | "debate",
  updates: MeetingProgressUpdate[],
  executeDetails?: TeamRunDetails,
  result?: MeetingRunResult,
): MeetingCardPayload {
  return {
    meetingName,
    mode,
    executePayload: executeDetails ? buildTeamCardPayload(executeDetails) : undefined,
    updates: [...updates],
    isFinished: Boolean(result),
    isError: result?.isError ?? false,
    errorMessage: result?.errorMessage,
  };
}

function renderMeetingProgressLines(
  payload: MeetingCardPayload,
  styler: Styler,
  theme?: Theme,
): string[] {
  const lines: string[] = [];

  if (payload.mode === "execute" && payload.executePayload) {
    return renderTeamCardLines(payload.executePayload, 0, theme);
  }

  const latest = payload.updates[payload.updates.length - 1];
  if (!latest) {
    lines.push(styler.muted(`${payload.meetingName} (${payload.mode})`));
    return lines;
  }

  const phaseLabel = latest.phase === "review" ? "reviewing"
    : latest.phase === "fix" ? "fixing"
    : latest.phase === "position" ? "positions"
    : latest.phase === "critique" ? "cross-critique"
    : latest.phase === "synthesis" ? "synthesizing"
    : "running";

  const roundPart = latest.round !== undefined && latest.totalRounds !== undefined
    ? ` round ${latest.round}/${latest.totalRounds}`
    : "";

  const statusIcon = latest.status === "done"
    ? styler.success("✓")
    : latest.status === "error"
    ? styler.error("✗")
    : styler.accent("⟳");

  lines.push(`${statusIcon} ${styler.bold(payload.meetingName)} ${styler.muted(`(${payload.mode})`)} — ${styler.accent(phaseLabel)}${styler.muted(roundPart)}`);

  if (latest.lastWork) {
    const preview = latest.lastWork.split("\n")[0]?.slice(0, 80) ?? "";
    if (preview) lines.push(styler.dim(`  ${preview}`));
  }

  if (payload.isFinished) {
    if (payload.isError) {
      lines.push(styler.error(`  Failed: ${payload.errorMessage ?? "(error)"}`));
    } else if (payload.errorMessage) {
      lines.push(styler.highlight(`  Note: ${payload.errorMessage.split("\n")[0] ?? ""}`));
    } else {
      lines.push(styler.success("  Done."));
    }
  }

  return lines;
}

export function renderMeetingCardLines(
  payload: MeetingCardPayload,
  _expanded: boolean,
  theme?: Theme,
): string[] {
  const styler = theme ? createThemeStyler(theme) : createPlainStyler();
  return renderMeetingProgressLines(payload, styler, theme);
}

export function renderMeetingResult(
  result: MeetingRunResult,
  expanded: boolean,
  theme?: Theme,
): string {
  const styler = theme ? createThemeStyler(theme) : createPlainStyler();

  if (result.isError) {
    return styler.error(`Meeting "${result.meetingName}" failed: ${result.errorMessage ?? "(unknown error)"}`);
  }

  const lines: string[] = [];
  lines.push(styler.success(`Meeting "${result.meetingName}" (${result.mode}) complete.`));

  if (result.errorMessage) {
    lines.push(styler.highlight(result.errorMessage.split("\n")[0] ?? ""));
  }

  if (expanded && result.finalText) {
    lines.push("");
    const preview = result.finalText.slice(0, 2000);
    lines.push(preview);
    if (result.finalText.length > 2000) {
      lines.push(styler.muted(`... (${result.finalText.length - 2000} more chars)`));
    }
  }

  return lines.join("\n");
}
