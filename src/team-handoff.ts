import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { TeamMemberResult } from "./team-runtime.js";
import { getFinalOutput } from "./workflow-runtime.js";

export interface TeamMemberDone {
  agent: string;
  phaseIndex: number;
  memberIndex: number;
  status: "completed" | "failed";
  extractionStatus: "extracted" | "fallback";
  summary: string;
  decisions: string[];
  artifacts: string[];
  blockers: string[];
  rawOutput: string;
}

export interface TeamSharedState {
  allDecisions: string[];
  allArtifacts: string[];
  allBlockers: string[];
}

interface ExtractionPayload {
  summary: string;
  decisions: string[];
  artifacts: string[];
  blockers: string[];
}

const RAW_OUTPUT_CHAR_LIMIT = 16_000;
const SUMMARY_FALLBACK_CHAR_LIMIT = 400;
const HANDOFF_CHAR_LIMIT = 32_000;
const HANDOFF_WARNING = "[WARNING: prior phase outputs were truncated to fit 32000 chars]";
const EXTRACTION_TIMEOUT_MS = 30_000;
const EXTRACTION_SYSTEM_PROMPT = [
  "You extract structured handoff data from a single agent's prose output.",
  "Return exactly one JSON object and nothing else.",
  'Schema: {"summary": string, "decisions": string[], "artifacts": string[], "blockers": string[]}.',
  "Do not invent file changes, decisions, or blockers that are not supported by the text.",
  "Keep summary to 1-3 sentences.",
].join("\n");

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    output.push(trimmed);
  }
  return output;
}

function truncateText(text: string, maxChars: number): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return ".".repeat(maxChars);
  return `${text.slice(0, maxChars - 3)}...`;
}

function writePromptToTempFile(
  label: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-team-extract-"));
  const safeName = label.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tempDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tempDir, filePath };
}

function getAssistantText(message: Message): string {
  if (message.role !== "assistant") return "";
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function getJsonModeFinalOutput(stdout: string): string {
  let finalOutput = "";
  const lines = stdout.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      (parsed as { type?: string }).type === "message_end" &&
      "message" in parsed
    ) {
      const message = (parsed as { message?: Message }).message;
      if (message) {
        const text = getAssistantText(message);
        if (text) finalOutput = text;
      }
      continue;
    }

    if (
      parsed &&
      typeof parsed === "object" &&
      "type" in parsed &&
      (parsed as { type?: string }).type === "agent_end" &&
      "messages" in parsed
    ) {
      const messages = (parsed as { messages?: Message[] }).messages;
      if (!Array.isArray(messages)) continue;
      for (let index = messages.length - 1; index >= 0; index--) {
        const text = getAssistantText(messages[index]);
        if (text) {
          finalOutput = text;
          break;
        }
      }
    }
  }
  return finalOutput.trim();
}

function isExtractionPayload(value: unknown): value is ExtractionPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.summary === "string" &&
    Array.isArray(record.decisions) &&
    Array.isArray(record.artifacts) &&
    Array.isArray(record.blockers)
  );
}

function normalizeExtractionPayload(value: unknown): ExtractionPayload | undefined {
  if (!isExtractionPayload(value)) return undefined;
  return {
    summary: value.summary.trim(),
    decisions: uniqueStrings(
      value.decisions.filter((item): item is string => typeof item === "string"),
    ),
    artifacts: uniqueStrings(
      value.artifacts.filter((item): item is string => typeof item === "string"),
    ),
    blockers: uniqueStrings(
      value.blockers.filter((item): item is string => typeof item === "string"),
    ),
  };
}

function isFailedMember(result: TeamMemberResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    !getFinalOutput(result.messages).trim() ||
    Boolean(result.errorMessage)
  );
}

function buildFallbackDone(result: TeamMemberResult, rawOutput: string): TeamMemberDone {
  const summarySource = rawOutput || result.errorMessage?.trim() || "(no output)";
  return {
    agent: result.agent,
    phaseIndex: result.phaseIndex,
    memberIndex: result.memberIndex,
    status: isFailedMember(result) ? "failed" : "completed",
    extractionStatus: "fallback",
    summary: truncateText(summarySource, SUMMARY_FALLBACK_CHAR_LIMIT),
    decisions: [],
    artifacts: [],
    blockers: [],
    rawOutput,
  };
}

async function runExtractionPrompt(
  cwd: string,
  rawOutput: string,
  defaultModel: string | undefined,
  label: string,
): Promise<string | undefined> {
  const args = ["--mode", "json", "-p", "--no-session", "--no-tools"];
  if (defaultModel?.trim()) args.push("--model", defaultModel.trim());

  const tempPrompt = writePromptToTempFile(label, EXTRACTION_SYSTEM_PROMPT);
  args.push("--append-system-prompt", tempPrompt.filePath);
  args.push(
    `Extract a structured summary from this agent output. Return only valid JSON.\n\n${rawOutput}`,
  );

  try {
    return await new Promise<string | undefined>((resolve) => {
      const proc = spawn("pi", args, {
        cwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        proc.kill("SIGKILL");
      }, EXTRACTION_TIMEOUT_MS);

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });
      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });
      proc.on("error", () => {
        clearTimeout(timeout);
        resolve(undefined);
      });
      proc.on("close", (code) => {
        clearTimeout(timeout);
        if (timedOut || code !== 0 || stderr.trim()) {
          resolve(undefined);
          return;
        }
        const finalOutput = getJsonModeFinalOutput(stdout);
        resolve(finalOutput || undefined);
      });
    });
  } finally {
    try {
      fs.unlinkSync(tempPrompt.filePath);
    } catch {
      /* ignore */
    }
    try {
      fs.rmdirSync(tempPrompt.dir);
    } catch {
      /* ignore */
    }
  }
}

function formatBulletList(items: string[]): string {
  if (items.length === 0) return " (none)";
  return `\n${items.map((item) => `- ${item}`).join("\n")}`;
}

function buildSummarySection(
  userTask: string,
  sharedState: TeamSharedState,
  doneRecords: TeamMemberDone[],
): string {
  const sortedDoneRecords = [...doneRecords].sort((left, right) => left.memberIndex - right.memberIndex);
  const lines = ["## Team Task", userTask, "", "## Prior Decisions (all phases)"];
  if (sharedState.allDecisions.length > 0) {
    lines.push(...sharedState.allDecisions.map((item) => `- ${item}`));
  } else {
    lines.push("(none)");
  }

  lines.push("", "## What Phase Produced");
  for (const [index, done] of sortedDoneRecords.entries()) {
    lines.push(`### ${done.agent} (member ${index + 1} of ${sortedDoneRecords.length})`);
    lines.push(`Summary: ${done.summary || "(none)"}`);
    lines.push(`Decisions:${formatBulletList(done.decisions)}`);
    lines.push(`Files touched:${formatBulletList(done.artifacts)}`);
    lines.push(`Needs attention:${formatBulletList(done.blockers)}`);
    lines.push("");
  }

  while (lines.at(-1) === "") lines.pop();
  return lines.join("\n");
}

function allocateBodyLengths(lengths: number[], maxChars: number): number[] {
  if (maxChars <= 0) return lengths.map(() => 0);
  const total = lengths.reduce((sum, value) => sum + value, 0);
  if (total <= maxChars) return [...lengths];

  const allocations = lengths.map((length) =>
    length === 0 ? 0 : Math.max(1, Math.floor((length / total) * maxChars)),
  );
  let allocated = allocations.reduce((sum, value) => sum + value, 0);

  while (allocated > maxChars) {
    const index = allocations.findIndex((value) => value > 1);
    if (index < 0) break;
    allocations[index] -= 1;
    allocated -= 1;
  }

  while (allocated < maxChars) {
    let updated = false;
    for (let index = 0; index < allocations.length && allocated < maxChars; index++) {
      if (allocations[index] >= lengths[index]) continue;
      allocations[index] += 1;
      allocated += 1;
      updated = true;
    }
    if (!updated) break;
  }

  return allocations;
}

function buildFullOutputsSection(doneRecords: TeamMemberDone[], maxChars: number): {
  text: string;
  truncated: boolean;
} {
  const sortedDoneRecords = [...doneRecords].sort((left, right) => left.memberIndex - right.memberIndex);
  const sectionTitle = "## Full Outputs (for reference)";
  const headers = sortedDoneRecords.map(
    (done, index) => `### ${done.agent} (member ${index + 1} of ${sortedDoneRecords.length})\n`,
  );
  const joiner = "\n\n";
  const fixedLength =
    sectionTitle.length +
    2 +
    headers.reduce((sum, header) => sum + header.length, 0) +
    joiner.length * Math.max(0, headers.length - 1);
  const bodyBudget = Math.max(0, maxChars - fixedLength);
  const rawOutputs = sortedDoneRecords.map((done) => done.rawOutput);
  const allocations = allocateBodyLengths(rawOutputs.map((item) => item.length), bodyBudget);
  const truncated = rawOutputs.some((item, index) => item.length > allocations[index]);
  const blocks = sortedDoneRecords.map((done, index) => {
    const body = truncateText(done.rawOutput, allocations[index]);
    return `${headers[index]}${body}`;
  });

  return {
    text: [sectionTitle, blocks.join(joiner)].join("\n\n").trimEnd(),
    truncated,
  };
}

export function createEmptyTeamSharedState(): TeamSharedState {
  return {
    allDecisions: [],
    allArtifacts: [],
    allBlockers: [],
  };
}

export async function extractMemberDone(
  cwd: string,
  result: TeamMemberResult,
  defaultModel: string | undefined,
): Promise<TeamMemberDone> {
  const rawOutput = truncateText(getFinalOutput(result.messages).trim(), RAW_OUTPUT_CHAR_LIMIT);
  if (!rawOutput) return buildFallbackDone(result, rawOutput);

  const extractedText = await runExtractionPrompt(
    cwd,
    rawOutput,
    defaultModel,
    `${result.agent}-${result.phaseIndex}-${result.memberIndex}`,
  );
  if (!extractedText) return buildFallbackDone(result, rawOutput);

  let parsed: unknown;
  try {
    parsed = JSON.parse(extractedText);
  } catch {
    return buildFallbackDone(result, rawOutput);
  }

  const normalized = normalizeExtractionPayload(parsed);
  if (!normalized) return buildFallbackDone(result, rawOutput);

  return {
    agent: result.agent,
    phaseIndex: result.phaseIndex,
    memberIndex: result.memberIndex,
    status: isFailedMember(result) ? "failed" : "completed",
    extractionStatus: "extracted",
    summary:
      normalized.summary || truncateText(rawOutput, SUMMARY_FALLBACK_CHAR_LIMIT),
    decisions: normalized.decisions,
    artifacts: normalized.artifacts,
    blockers: normalized.blockers,
    rawOutput,
  };
}

export function mergePhaseIntoSharedState(
  sharedState: TeamSharedState,
  doneRecords: TeamMemberDone[],
): TeamSharedState {
  return {
    allDecisions: uniqueStrings([
      ...sharedState.allDecisions,
      ...doneRecords.flatMap((done) => done.decisions),
    ]),
    allArtifacts: uniqueStrings([
      ...sharedState.allArtifacts,
      ...doneRecords.flatMap((done) => done.artifacts),
    ]),
    allBlockers: uniqueStrings(doneRecords.flatMap((done) => done.blockers)),
  };
}

export function buildPhaseHandoff(
  userTask: string,
  sharedState: TeamSharedState,
  doneRecords: TeamMemberDone[],
): string {
  const summarySection = buildSummarySection(userTask, sharedState, doneRecords);
  const fullOutputsLimit =
    HANDOFF_CHAR_LIMIT -
    summarySection.length -
    2 -
    (HANDOFF_WARNING.length + 2);
  const fullOutputsSection = buildFullOutputsSection(
    doneRecords,
    Math.max(0, fullOutputsLimit),
  );
  const body = `${summarySection}\n\n${fullOutputsSection.text}`.trimEnd();
  if (!fullOutputsSection.truncated && body.length <= HANDOFF_CHAR_LIMIT) return body;
  return `${HANDOFF_WARNING}\n\n${body}`;
}
