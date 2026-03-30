import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentConfig } from "./agents.js";
import { discoverAgents } from "./agents.js";
import type {
  MeetingConfig,
  MeetingDebateConfig,
  MeetingExecuteConfig,
  MeetingParticipantSpec,
  MeetingRefineConfig,
  MeetingSource,
} from "./meetings.js";
import { discoverMeetings } from "./meetings.js";
import {
  spawnRpcProcess,
  runTeamPhases,
  type RpcProcessResult,
  type TeamRunResult,
} from "./team-runtime.js";
import type { TeamConfig } from "./teams.js";
import { getFinalOutput } from "./workflow-runtime.js";

const DEFAULT_PARTICIPANT_TIMEOUT_MS = 10 * 60 * 1000;

async function withParticipantTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Participant "${label}" timed out after ${Math.round(timeoutMs / 1000)}s.`)),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface MeetingRunResult {
  meetingName: string;
  meetingSource: MeetingSource;
  meetingFilePath: string | null;
  mode: "execute" | "refine" | "debate";
  isError: boolean;
  errorMessage?: string;
  finalText: string;
  executeResult?: TeamRunResult;
}

export type MeetingUpdateCallback = (update: MeetingProgressUpdate) => void;

export interface MeetingProgressUpdate {
  meetingName: string;
  mode: "execute" | "refine" | "debate";
  phase: "execute" | "review" | "fix" | "position" | "critique" | "synthesis";
  round?: number;
  totalRounds?: number;
  participant?: string;
  status: "running" | "done" | "error";
  lastWork: string;
}

interface RefineVerdict {
  ready: boolean;
  blockers: string[];
  concerns: string[];
  raw: string;
}

function parseRefineVerdict(output: string): RefineVerdict {
  const verdictMatch = output.match(/^VERDICT:\s*(READY|NOT_READY)/im);
  const ready = verdictMatch?.[1]?.toUpperCase() === "READY";

  const blockers: string[] = [];
  const blockerSection = output.match(/##\s*Blockers[^\n]*\n([\s\S]*?)(?=##\s*Concerns|##\s*Questions|$)/i);
  if (blockerSection) {
    const issueMatches = blockerSection[1].matchAll(/^-\s*\*\*?Issue\*\*?:\s*(.+)$/gim);
    for (const match of issueMatches) {
      const trimmed = match[1].trim();
      if (trimmed) blockers.push(trimmed);
    }
  }

  const concerns: string[] = [];
  const concernSection = output.match(/##\s*Concerns[^\n]*\n([\s\S]*?)(?=##\s*Questions|$)/i);
  if (concernSection) {
    const issueMatches = concernSection[1].matchAll(/^-\s*\*\*?Issue\*\*?:\s*(.+)$/gim);
    for (const match of issueMatches) {
      const trimmed = match[1].trim();
      if (trimmed) concerns.push(trimmed);
    }
  }

  return { ready, blockers, concerns, raw: output };
}

function fileContentHash(filePath: string): string | null {
  try {
    const content = fs.readFileSync(filePath);
    return crypto.createHash("md5").update(content).digest("hex");
  } catch {
    return null;
  }
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) return error.message.trim() || error.name;
  return typeof error === "string" ? error.trim() || "Unknown error" : "Unknown error";
}

function isRpcFailed(result: RpcProcessResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    Boolean(result.errorMessage)
  );
}

function checkExternalCliAvailable(cli: "codex" | "opencode"): boolean {
  const result = spawnSync(cli === "codex" ? "codex" : "opencode", ["--version"], {
    shell: false,
    timeout: 5000,
    encoding: "utf-8",
  });
  return result.status === 0 || result.status === 1;
}

async function runExternalCli(
  cli: "codex" | "opencode",
  prompt: string,
  reasoning?: string,
  signal?: AbortSignal,
): Promise<RpcProcessResult> {
  const { spawn } = await import("node:child_process");
  const startTime = Date.now();

  let args: string[];
  let env: NodeJS.ProcessEnv;

  if (cli === "codex") {
    args = ["exec", "--full-auto"];
    if (reasoning) args.push("--reasoning-effort", reasoning);
    args.push(prompt);
    env = { ...process.env };
  } else {
    args = ["--log-level", "DEBUG", "run", prompt];
    env = {
      ...process.env,
      https_proxy: process.env.HTTPS_PROXY ?? process.env.https_proxy ?? "",
      http_proxy: process.env.HTTP_PROXY ?? process.env.http_proxy ?? "",
      no_proxy: process.env.NO_PROXY ?? process.env.no_proxy ?? "",
    };
  }

  return new Promise<RpcProcessResult>((resolve) => {
    const proc = spawn(cli === "codex" ? "codex" : "opencode", args, {
      shell: false,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

    const onAbort = () => { proc.kill("SIGTERM"); };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    proc.on("close", (code) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      const exitCode = code ?? 0;
      const elapsedMs = Date.now() - startTime;
      const lastWork = stdout.trim();
      const errorMessage = exitCode !== 0 && !lastWork
        ? (stderr.trim() || `External CLI "${cli}" exited with code ${exitCode}.`)
        : undefined;
      resolve({
        messages: [],
        exitCode,
        stderr,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: undefined,
        stopReason: exitCode !== 0 ? "error" : undefined,
        errorMessage,
        elapsedMs,
        lastWork,
      });
    });

    proc.on("error", (error: Error) => {
      if (signal) signal.removeEventListener("abort", onAbort);
      resolve({
        messages: [],
        exitCode: 1,
        stderr: error.message,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
        model: undefined,
        stopReason: "error",
        errorMessage: error.message,
        elapsedMs: Date.now() - startTime,
        lastWork: "",
      });
    });
  });
}

async function runParticipant(
  spec: MeetingParticipantSpec,
  prompt: string,
  cwd: string,
  agents: AgentConfig[],
  defaultModel: string | undefined,
  signal?: AbortSignal,
): Promise<RpcProcessResult> {
  if (typeof spec === "string") {
    const agent = agents.find((a) => a.name === spec);
    if (!agent) throw new Error(`Meeting participant agent not found: "${spec}".`);
    const rpc = spawnRpcProcess(cwd, agent, defaultModel);
    return rpc.run(prompt, signal);
  }
  return runExternalCli(spec.cli, prompt, spec.reasoning, signal);
}

function resolveParticipantSpec(
  spec: MeetingParticipantSpec,
  role: "reviewer" | "fixer" | "participant",
  agents: AgentConfig[],
  onWarning: (msg: string) => void,
): MeetingParticipantSpec {
  if (typeof spec === "object") {
    if (!checkExternalCliAvailable(spec.cli)) {
      const fallback = role === "fixer" ? "build" : "plan";
      onWarning(`External CLI "${spec.cli}" is unavailable. Falling back to built-in pi agent "${fallback}".`);
      return fallback;
    }
    return spec;
  }
  if (!agents.some((a) => a.name === spec)) {
    throw new Error(`Meeting participant agent not found: "${spec}".`);
  }
  return spec;
}

async function runExecuteMeeting(
  config: MeetingExecuteConfig,
  task: string,
  cwd: string,
  agents: AgentConfig[],
  defaultModel: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: MeetingUpdateCallback | undefined,
): Promise<MeetingRunResult> {
  const teamConfig: TeamConfig = {
    name: config.name,
    phases: config.phases.map((p) => ({ kind: p.kind, agentNames: p.agentNames })),
    source: config.source === "built-in" ? "built-in" : config.source === "global" ? "global" : "project",
    filePath: config.filePath,
  };

  onUpdate?.({
    meetingName: config.name,
    mode: "execute",
    phase: "execute",
    status: "running",
    lastWork: "(running...)",
  });

  const result = await runTeamPhases(
    cwd,
    teamConfig,
    agents,
    task,
    defaultModel,
    signal,
    undefined,
    undefined,
  );

  onUpdate?.({
    meetingName: config.name,
    mode: "execute",
    phase: "execute",
    status: result.isError ? "error" : "done",
    lastWork: result.isError ? (result.errorMessage ?? "(failed)") : result.finalText,
  });

  return {
    meetingName: config.name,
    meetingSource: config.source,
    meetingFilePath: config.filePath ?? null,
    mode: "execute",
    isError: result.isError,
    errorMessage: result.errorMessage,
    finalText: result.isError ? "" : result.finalText,
    executeResult: result,
  };
}

async function runRefineMeeting(
  config: MeetingRefineConfig,
  task: string,
  artifactPath: string | undefined,
  cwd: string,
  agents: AgentConfig[],
  defaultModel: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: MeetingUpdateCallback | undefined,
  onWarning: (msg: string) => void,
): Promise<MeetingRunResult> {
  const reviewer = resolveParticipantSpec(config.reviewer, "reviewer", agents, onWarning);
  const fixer = resolveParticipantSpec(config.fixer, "fixer", agents, onWarning);

  const isFileBased = config.output === "file";
  let inMemoryArtifact: string;
  let targetPath: string | undefined;

  if (isFileBased) {
    if (artifactPath) {
      targetPath = path.resolve(cwd, artifactPath);
      try {
        inMemoryArtifact = fs.readFileSync(targetPath, "utf-8");
      } catch {
        inMemoryArtifact = "";
      }
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      targetPath = path.join(cwd, `${config.name}-${timestamp}.md`);
      inMemoryArtifact = task;
    }
  } else {
    if (artifactPath) {
      try {
        inMemoryArtifact = fs.readFileSync(path.resolve(cwd, artifactPath), "utf-8");
      } catch {
        inMemoryArtifact = task;
      }
    } else {
      inMemoryArtifact = task;
    }
  }

  let prevBlockers: string[] = [];
  let consecutiveNoChange = 0;
  let finalText = inMemoryArtifact;
  const maxRounds = config.rounds;

  for (let round = 1; round <= maxRounds; round++) {
    if (signal?.aborted) {
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: true, errorMessage: "Meeting was aborted.", finalText };
    }

    const reviewerPrompt = [
      `## Topic\n${task}`,
      `## Current Artifact\n${inMemoryArtifact}`,
      `\nReview the artifact above against these 9 dimensions: Problem Understanding, Completeness, Technical Approach, Assumptions & Risks, Scope Appropriateness, Workload Size, Contract Consistency, Implementation Readiness, Open Questions.`,
      `Output your review in this exact format:\nVERDICT: READY|NOT_READY\nBLOCKERS: <count>\nCONCERNS: <count>\n\n## Blockers (Must Fix)\n### <Dimension>\n- **Issue**: ...\n- **Location**: ...\n- **Suggestion**: ...\n\n## Concerns (Should Fix)\n...`,
    ].join("\n\n");

    onUpdate?.({ meetingName: config.name, mode: "refine", phase: "review", round, totalRounds: maxRounds, status: "running", lastWork: `Round ${round}: reviewing...` });

    const reviewResult = await withParticipantTimeout(
      runParticipant(reviewer, reviewerPrompt, cwd, agents, defaultModel, signal),
      DEFAULT_PARTICIPANT_TIMEOUT_MS,
      typeof reviewer === "string" ? reviewer : reviewer.cli,
    );
    const reviewOutput = reviewResult.lastWork || getFinalOutput(reviewResult.messages);

    if (isRpcFailed(reviewResult) && !reviewOutput) {
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: true, errorMessage: `Reviewer failed in round ${round}: ${reviewResult.errorMessage ?? "(no output)"}`, finalText };
    }

    onUpdate?.({ meetingName: config.name, mode: "refine", phase: "review", round, totalRounds: maxRounds, status: "done", lastWork: reviewOutput.slice(0, 200) });

    const verdict = parseRefineVerdict(reviewOutput);

    if (verdict.ready) {
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: false, finalText };
    }

    if (round > 1 && verdict.blockers.length > 0 && verdict.blockers.join("\n") === prevBlockers.join("\n")) {
      const stuckMsg = `Meeting "${config.name}" is stuck after round ${round}: same blockers as previous round. Needs human input.\n\nBlockers:\n${verdict.blockers.map((b) => `- ${b}`).join("\n")}`;
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: false, errorMessage: stuckMsg, finalText };
    }
    prevBlockers = [...verdict.blockers];

    if (round === maxRounds) {
      const remainingMsg = `Meeting "${config.name}" reached max rounds (${maxRounds}). Remaining blockers:\n${verdict.blockers.map((b) => `- ${b}`).join("\n")}`;
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: false, errorMessage: remainingMsg, finalText };
    }

    const fixerPrompt = isFileBased && targetPath
      ? [
          `## Topic\n${task}`,
          `## Review Feedback\n${reviewOutput}`,
          `## Artifact File\n${targetPath}`,
          `Address the BLOCKER items from the review above. Update the artifact at the exact path: ${targetPath}\nWrite the updated content back to that file.`,
        ].join("\n\n")
      : [
          `## Topic\n${task}`,
          `## Current Artifact\n${inMemoryArtifact}`,
          `## Review Feedback\n${reviewOutput}`,
          `Address the BLOCKER items from the review above. Output the complete updated artifact as your response. Do not include any preamble — only the updated artifact content.`,
        ].join("\n\n");

    const hashBefore = isFileBased && targetPath ? fileContentHash(targetPath) : null;

    onUpdate?.({ meetingName: config.name, mode: "refine", phase: "fix", round, totalRounds: maxRounds, status: "running", lastWork: `Round ${round}: fixing...` });

    const fixResult = await withParticipantTimeout(
      runParticipant(fixer, fixerPrompt, cwd, agents, defaultModel, signal),
      DEFAULT_PARTICIPANT_TIMEOUT_MS,
      typeof fixer === "string" ? fixer : fixer.cli,
    );

    if (isRpcFailed(fixResult)) {
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: true, errorMessage: `Fixer failed in round ${round}: ${fixResult.errorMessage ?? "(error)"}`, finalText };
    }

    const fixOutput = fixResult.lastWork || getFinalOutput(fixResult.messages);

    if (isFileBased && targetPath) {
      const hashAfter = fileContentHash(targetPath);
      if (hashAfter === null && hashBefore !== null) {
        return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: true, errorMessage: `Fixer did not produce the expected file at ${targetPath}.`, finalText };
      }
      if (hashAfter === hashBefore) {
        consecutiveNoChange++;
        if (consecutiveNoChange >= 2) {
          return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: false, errorMessage: `Fixer produced no changes after two consecutive rounds — stopping. Needs human input.`, finalText };
        }
      } else {
        consecutiveNoChange = 0;
        try {
          inMemoryArtifact = fs.readFileSync(targetPath, "utf-8");
          finalText = inMemoryArtifact;
        } catch { /* ignore */ }
      }
    } else {
      if (!fixOutput.trim()) {
        consecutiveNoChange++;
        if (consecutiveNoChange >= 2) {
          return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: false, errorMessage: `Fixer produced no output after two consecutive rounds — stopping. Needs human input.`, finalText };
        }
      } else {
        consecutiveNoChange = 0;
        inMemoryArtifact = fixOutput;
        finalText = inMemoryArtifact;
      }
    }

    onUpdate?.({ meetingName: config.name, mode: "refine", phase: "fix", round, totalRounds: maxRounds, status: "done", lastWork: fixOutput.slice(0, 200) });
  }

  return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "refine", isError: false, finalText };
}

async function runDebateMeeting(
  config: MeetingDebateConfig,
  task: string,
  artifactPath: string | undefined,
  cwd: string,
  agents: AgentConfig[],
  defaultModel: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: MeetingUpdateCallback | undefined,
  onWarning: (msg: string) => void,
): Promise<MeetingRunResult> {
  const resolvedParticipants: Array<{ role: string; spec: MeetingParticipantSpec }> = [];
  const unavailable: string[] = [];

  for (const p of config.participants) {
    try {
      const spec = resolveParticipantSpec(p.agent, "participant", agents, onWarning);
      if (typeof spec === "object" && typeof p.agent === "object" && !checkExternalCliAvailable(p.agent.cli)) {
        unavailable.push(p.role);
      } else {
        resolvedParticipants.push({ role: p.role, spec });
      }
    } catch {
      unavailable.push(p.role);
    }
  }

  if (resolvedParticipants.length < 2) {
    const msg = `Meeting "${config.name}" cannot start: fewer than 2 debate participants available after availability check.${unavailable.length > 0 ? ` Unavailable: ${unavailable.join(", ")}.` : ""}`;
    return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "debate", isError: true, errorMessage: msg, finalText: "" };
  }

  let artifactContent = "";
  if (artifactPath) {
    try {
      artifactContent = fs.readFileSync(path.resolve(cwd, artifactPath), "utf-8");
    } catch { /* ignore */ }
  }

  const phase1Prompt = [
    `## Topic\n${task}`,
    artifactContent ? `## Reference Artifact\n${artifactContent}` : "",
    `\nProvide your independent analysis and position on this topic. Be specific and concrete.`,
  ].filter(Boolean).join("\n\n");

  onUpdate?.({ meetingName: config.name, mode: "debate", phase: "position", round: 1, status: "running", lastWork: "Phase 1: parallel positions..." });

  const phase1Results = await Promise.all(
    resolvedParticipants.map((p) =>
      withParticipantTimeout(
        runParticipant(p.spec, phase1Prompt, cwd, agents, defaultModel, signal),
        DEFAULT_PARTICIPANT_TIMEOUT_MS,
        p.role,
      ).then((result) => ({ role: p.role, spec: p.spec, result })),
    ),
  );

  const positions: Array<{ role: string; output: string }> = phase1Results.map((r) => ({
    role: r.role,
    output: r.result.lastWork || getFinalOutput(r.result.messages),
  }));

  onUpdate?.({ meetingName: config.name, mode: "debate", phase: "position", round: 1, status: "done", lastWork: "Phase 1 complete." });

  let latestPositions = [...positions];

  for (let round = 1; round <= config.rounds; round++) {
    if (signal?.aborted) {
      return { meetingName: config.name, meetingSource: config.source, meetingFilePath: config.filePath ?? null, mode: "debate", isError: true, errorMessage: "Meeting was aborted.", finalText: "" };
    }

    onUpdate?.({ meetingName: config.name, mode: "debate", phase: "critique", round, totalRounds: config.rounds, status: "running", lastWork: `Round ${round}: cross-critique...` });

    const capturedPositions = [...latestPositions];
    const critiqueResults = await Promise.all(
      resolvedParticipants.map(async (p) => {
        const othersOutput = capturedPositions
          .filter((pos) => pos.role !== p.role)
          .map((pos) => `### A colleague's position\n${pos.output}`)
          .join("\n\n");

        const critiquePrompt = [
          `## Topic\n${task}`,
          `## Your Previous Position\n${capturedPositions.find((pos) => pos.role === p.role)?.output ?? ""}`,
          `## Colleague Positions (for cross-critique)\n${othersOutput}`,
          `First write a steelman of the strongest colleague position (5-8 sentences). Then provide your critique and updated position. Maintain your original position unless you find a specific factual error.`,
        ].join("\n\n");

        const critiqueResult = await withParticipantTimeout(
          runParticipant(p.spec, critiquePrompt, cwd, agents, defaultModel, signal),
          DEFAULT_PARTICIPANT_TIMEOUT_MS,
          p.role,
        );
        return { role: p.role, output: critiqueResult.lastWork || getFinalOutput(critiqueResult.messages) };
      }),
    );
    latestPositions = critiqueResults;

    onUpdate?.({ meetingName: config.name, mode: "debate", phase: "critique", round, totalRounds: config.rounds, status: "done", lastWork: `Round ${round} complete.` });
  }

  onUpdate?.({ meetingName: config.name, mode: "debate", phase: "synthesis", status: "running", lastWork: "Synthesizing..." });

  const allPositions = latestPositions.map((p) => `### ${p.role}\n${p.output}`).join("\n\n");

  const synthesisPrompt = [
    `## Topic\n${task}`,
    `## Final Positions\n${allPositions}`,
    [
      `You are synthesizing a multi-agent debate. Produce a structured synthesis with these sections:`,
      `1. **Convergent Points** — where all participants agreed`,
      `2. **Divergent Points** — key disagreements; classify each as factual (D-F), predictive (D-P), value-based (D-V), or unknown (D-U)`,
      `3. **Unique Insights** — perspectives raised by only one participant`,
      `4. **Recommendation** — the most defensible position given the evidence, or state explicitly if no clear winner`,
      `5. **Confidence** — HIGH / MEDIUM / LOW based on convergence level`,
      `Be specific and cite participant roles when referencing positions.`,
    ].join("\n"),
  ].join("\n\n");

  const synthesizerSpec = resolvedParticipants[0]?.spec ?? "plan";
  let synthesisText: string;
  try {
    const synthesisResult = await withParticipantTimeout(
      runParticipant(synthesizerSpec, synthesisPrompt, cwd, agents, defaultModel, signal),
      DEFAULT_PARTICIPANT_TIMEOUT_MS,
      "synthesizer",
    );
    synthesisText = synthesisResult.lastWork || getFinalOutput(synthesisResult.messages);
    if (!synthesisText.trim()) synthesisText = allPositions;
  } catch {
    synthesisText = allPositions;
  }

  const synthesisContent = [
    `# Meeting Synthesis: ${config.name}`,
    `## Topic\n${task}`,
    `## Synthesis\n${synthesisText}`,
    `## Full Positions\n${allPositions}`,
  ].join("\n\n");

  let outputPath: string | undefined;
  if (config.output === "file") {
    if (artifactPath) {
      const parsed = path.parse(path.resolve(cwd, artifactPath));
      outputPath = path.join(parsed.dir, `${parsed.name}-synthesis${parsed.ext}`);
    } else {
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      outputPath = path.join(cwd, `${config.name}-${timestamp}-synthesis.md`);
    }
    try {
      fs.writeFileSync(outputPath, synthesisContent, "utf-8");
    } catch (error) {
      onWarning(`Could not write synthesis to file: ${describeUnknownError(error)}. Output will be in session only.`);
      outputPath = undefined;
    }
  }

  onUpdate?.({ meetingName: config.name, mode: "debate", phase: "synthesis", status: "done", lastWork: outputPath ? `Synthesis written to ${outputPath}` : "Synthesis complete." });

  return {
    meetingName: config.name,
    meetingSource: config.source,
    meetingFilePath: config.filePath ?? null,
    mode: "debate",
    isError: false,
    finalText: config.output === "file" && outputPath ? `Synthesis written to: ${outputPath}\n\n${synthesisContent}` : synthesisContent,
  };
}

export async function runMeetingByName(
  cwd: string,
  meetingName: string,
  task: string,
  artifactPath: string | undefined,
  defaultModel: string | undefined,
  signal: AbortSignal | undefined,
  onUpdate: MeetingUpdateCallback | undefined,
  onWarning: (msg: string) => void,
): Promise<MeetingRunResult> {
  const { agents } = discoverAgents(cwd);
  const { meetings } = discoverMeetings(cwd);
  const meeting = meetings.find((m) => m.name === meetingName);

  if (!meeting) {
    return {
      meetingName,
      meetingSource: "built-in",
      meetingFilePath: null,
      mode: "execute",
      isError: true,
      errorMessage: `Unknown meeting: "${meetingName}"`,
      finalText: "",
    };
  }

  try {
    if (meeting.mode === "execute") {
      return runExecuteMeeting(meeting as MeetingExecuteConfig, task, cwd, agents, defaultModel, signal, onUpdate);
    }
    if (meeting.mode === "refine") {
      return runRefineMeeting(meeting as MeetingRefineConfig, task, artifactPath, cwd, agents, defaultModel, signal, onUpdate, onWarning);
    }
    return runDebateMeeting(meeting as MeetingDebateConfig, task, artifactPath, cwd, agents, defaultModel, signal, onUpdate, onWarning);
  } catch (error) {
    return {
      meetingName: meeting.name,
      meetingSource: meeting.source,
      meetingFilePath: meeting.filePath ?? null,
      mode: meeting.mode,
      isError: true,
      errorMessage: describeUnknownError(error),
      finalText: "",
    };
  }
}
