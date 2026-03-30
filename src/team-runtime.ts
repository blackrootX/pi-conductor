import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, AgentSource } from "./agents.js";
import { discoverAgents } from "./agents.js";
import {
  buildPhaseHandoff,
  createEmptyTeamSharedState,
  extractMemberDone,
  mergePhaseIntoSharedState,
  type TeamMemberDone,
} from "./team-handoff.js";
import type { TeamMemberState, TeamPhaseState } from "./team-cards.js";
import {
  acquireTeamLock,
  captureTeamRepositorySnapshot,
  collectTeamTouchedFiles,
  createTeamRunState,
  initTeamRunDir,
  releaseTeamLock,
  writeMemberDone,
  writeTeamState,
  type TeamRunLock,
  type TeamRunStatus,
} from "./team-state.js";
import type { TeamPhaseConfig, TeamConfig, TeamSource } from "./teams.js";
import { discoverTeams } from "./teams.js";
import { getFinalOutput, type UsageStats } from "./workflow-runtime.js";

export interface TeamMemberResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  phaseIndex: number;
  memberIndex: number;
  task: string;
  exitCode: number;
  elapsedMs: number;
  lastWork: string;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

export interface TeamRunDetails {
  teamName: string;
  teamSource: TeamSource;
  teamFilePath: string | null;
  runDir: string;
  phases: TeamPhaseState[];
  results: TeamMemberResult[];
}

export interface TeamRunResult extends TeamRunDetails {
  finalText: string;
  isError: boolean;
  errorMessage?: string;
}

export interface TeamRuntimeOptions {
  sequentializeParallelPhases?: boolean;
  timeoutMs?: number;
}

export type TeamUpdate = TeamRunDetails;
export type TeamUpdateCallback = (details: TeamUpdate) => void;

interface RpcResponseRecord {
  id?: string;
  type: "response";
  command?: string;
  success?: boolean;
  error?: string;
}

interface RpcMessageEndRecord {
  type: "message_end";
  message?: Message;
}

interface RpcAgentEndRecord {
  type: "agent_end";
  messages?: Message[];
}

interface RpcWorkerHandle {
  result: TeamMemberResult;
  waitPromise: Promise<TeamMemberResult>;
  abort: (reason: string) => void;
}

export interface RpcProcessResult {
  messages: Message[];
  exitCode: number;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  elapsedMs: number;
  lastWork: string;
}

export interface RpcProcess {
  run(task: string, signal?: AbortSignal): Promise<RpcProcessResult>;
  abort(reason: string): void;
}

export function spawnRpcProcess(
  cwd: string,
  agent: AgentConfig,
  defaultModel: string | undefined,
): RpcProcess {
  const args: string[] = ["--mode", "rpc", "--no-session"];
  const effectiveModel = getEffectiveModel(agent, defaultModel);
  if (effectiveModel) args.push("--model", effectiveModel);
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  let tempPromptDir: string | null = null;
  let tempPromptPath: string | null = null;
  if (agent.systemPrompt.trim()) {
    const tempPrompt = writePromptToTempFile(agent.name, agent.systemPrompt);
    tempPromptDir = tempPrompt.dir;
    tempPromptPath = tempPrompt.filePath;
    args.push("--append-system-prompt", tempPromptPath);
  }

  const proc = spawn("pi", args, {
    cwd,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let abortReason: string | undefined;
  let killTimer: NodeJS.Timeout | undefined;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const cleanupTempFiles = () => {
    if (tempPromptPath) {
      try { fs.unlinkSync(tempPromptPath); } catch { /* ignore */ }
    }
    if (tempPromptDir) {
      try { fs.rmdirSync(tempPromptDir); } catch { /* ignore */ }
    }
  };

  const clearKillTimers = () => {
    if (killTimer) clearTimeout(killTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
  };

  const doAbort = (reason: string) => {
    if (proc.exitCode !== null) return;
    abortReason = reason;
    try {
      proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    } catch { /* ignore */ }
    killTimer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGTERM");
    }, 3000);
    forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null) proc.kill("SIGKILL");
    }, 4000);
  };

  return {
    run(task: string, signal?: AbortSignal): Promise<RpcProcessResult> {
      const usage: UsageStats = createEmptyUsage();
      const messages: Message[] = [];
      let stderr = "";
      let model: string | undefined = effectiveModel;
      let stopReason: string | undefined;
      let errorMessage: string | undefined;
      let commandFailed = false;
      let promptResponded = false;
      let agentEnded = false;
      let buffer = "";
      const startTime = Date.now();
      const promptId = `prompt-${randomUUID()}`;

      const onSignalAbort = () => doAbort("Meeting run was aborted.");
      if (signal) {
        if (signal.aborted) {
          onSignalAbort();
        } else {
          signal.addEventListener("abort", onSignalAbort, { once: true });
        }
      }

      const updateUsage = (message: Message) => {
        if (message.role !== "assistant") return;
        usage.turns++;
        const u = message.usage;
        if (!u) return;
        usage.input += u.input || 0;
        usage.output += u.output || 0;
        usage.cacheRead += u.cacheRead || 0;
        usage.cacheWrite += u.cacheWrite || 0;
        usage.cost += u.cost?.total || 0;
        usage.contextTokens = u.totalTokens || 0;
      };

      const handleLine = (line: string) => {
        const normalized = line.endsWith("\r") ? line.slice(0, -1) : line;
        if (!normalized.trim()) return;
        let parsed: unknown;
        try { parsed = JSON.parse(normalized); } catch { return; }

        if (isRpcResponseRecord(parsed)) {
          if (parsed.id !== promptId || parsed.command !== "prompt") return;
          promptResponded = true;
          if (parsed.success === false) {
            commandFailed = true;
            errorMessage = parsed.error || "RPC prompt command failed.";
            stopReason = "error";
            try { proc.stdin.end(); } catch { /* ignore */ }
            proc.kill("SIGTERM");
          }
          return;
        }
        if (isRpcMessageEndRecord(parsed) && parsed.message) {
          messages.push(parsed.message);
          if (parsed.message.role === "assistant") {
            updateUsage(parsed.message);
            if (!model && parsed.message.model) model = parsed.message.model;
            if (parsed.message.stopReason) stopReason = parsed.message.stopReason;
            if (parsed.message.errorMessage) errorMessage = parsed.message.errorMessage;
          }
          return;
        }
        if (isRpcAgentEndRecord(parsed)) {
          agentEnded = true;
          if (messages.length === 0 && Array.isArray(parsed.messages)) {
            for (const m of parsed.messages) {
              messages.push(m);
              updateUsage(m);
            }
          }
          try { proc.stdin.end(); } catch { /* ignore */ }
        }
      };

      return new Promise<RpcProcessResult>((resolve) => {
        proc.stdout.on("data", (data: Buffer) => {
          buffer += data.toString();
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) handleLine(line);
        });
        proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        proc.on("close", (code) => {
          if (signal) signal.removeEventListener("abort", onSignalAbort);
          clearKillTimers();
          if (buffer.trim()) handleLine(buffer);
          const exitCode = code ?? 0;
          if (!errorMessage && abortReason) { errorMessage = abortReason; stopReason = "aborted"; }
          if (!promptResponded && !errorMessage) { errorMessage = "RPC worker exited before prompt response."; stopReason = "error"; }
          if (!agentEnded && (commandFailed || exitCode !== 0) && !errorMessage) {
            errorMessage = stderr.trim() || `RPC worker exited with code ${exitCode}.`;
            stopReason = "error";
          }
          const lastWork = getFinalOutput(messages);
          if (!lastWork.trim() && !errorMessage) { errorMessage = "Agent produced no text output."; stopReason = "error"; }
          if (!stopReason && errorMessage) stopReason = "error";
          cleanupTempFiles();
          resolve({
            messages,
            exitCode: commandFailed && exitCode === 0 ? 1 : exitCode,
            stderr,
            usage,
            model,
            stopReason,
            errorMessage,
            elapsedMs: Date.now() - startTime,
            lastWork,
          });
        });
        proc.on("error", (error: Error) => {
          errorMessage = error.message;
          stopReason = "error";
        });

        try {
          proc.stdin.write(JSON.stringify({ id: promptId, type: "prompt", message: task }) + "\n");
        } catch (error) {
          errorMessage = error instanceof Error ? error.message : String(error);
          stopReason = "error";
          commandFailed = true;
        }
      });
    },

    abort(reason: string) {
      doAbort(reason);
    },
  };
}

type TeamPhaseRunResult =
  | { ok: true; phaseResults: TeamMemberResult[] }
  | { ok: false; errorMessage: string; phaseResults: TeamMemberResult[] };

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const PHASE_WARNING_PREFIX = "agents claimed file changes but no files were modified";

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-team-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tempDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tempDir, filePath };
}

function createEmptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function cloneMessage(message: Message): Message {
  return JSON.parse(JSON.stringify(message)) as Message;
}

function cloneTeamMemberState(member: TeamMemberState): TeamMemberState {
  return { ...member };
}

function cloneTeamPhaseState(phase: TeamPhaseState): TeamPhaseState {
  return {
    kind: phase.kind,
    warningMessage: phase.warningMessage,
    members: phase.members.map(cloneTeamMemberState),
  };
}

function clonePhases(phases: TeamPhaseState[]): TeamPhaseState[] {
  return phases.map(cloneTeamPhaseState);
}

function getEffectiveModel(agent: AgentConfig, defaultModel: string | undefined): string | undefined {
  return agent.model ?? defaultModel;
}

function makeInitialPhaseStates(
  phases: TeamPhaseConfig[],
  agents: AgentConfig[],
  defaultModel: string | undefined,
): TeamPhaseState[] {
  return phases.map((phase) => ({
    kind: phase.kind,
    warningMessage: undefined,
    members: phase.agentNames.map((agentName) => {
      const agent = agents.find((item) => item.name === agentName);
      return {
        agent: agentName,
        model: agent ? getEffectiveModel(agent, defaultModel) : defaultModel,
        status: "pending",
        elapsedMs: 0,
        lastWork: "",
      };
    }),
  }));
}

function updateUsageFromMessage(result: TeamMemberResult, message: Message): void {
  if (message.role !== "assistant") return;

  result.usage.turns++;
  const usage = message.usage;
  if (!usage) return;

  result.usage.input += usage.input || 0;
  result.usage.output += usage.output || 0;
  result.usage.cacheRead += usage.cacheRead || 0;
  result.usage.cacheWrite += usage.cacheWrite || 0;
  result.usage.cost += usage.cost?.total || 0;
  result.usage.contextTokens = usage.totalTokens || 0;
}

function rebuildUsage(result: TeamMemberResult): void {
  result.usage = createEmptyUsage();
  for (const message of result.messages) {
    updateUsageFromMessage(result, message);
  }
}

function isRpcResponseRecord(value: unknown): value is RpcResponseRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      (value as Record<string, unknown>).type === "response",
  );
}

function isRpcMessageEndRecord(value: unknown): value is RpcMessageEndRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      (value as Record<string, unknown>).type === "message_end",
  );
}

function isRpcAgentEndRecord(value: unknown): value is RpcAgentEndRecord {
  return Boolean(
    value &&
      typeof value === "object" &&
      "type" in value &&
      (value as Record<string, unknown>).type === "agent_end",
  );
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

function formatMemberFailure(result: TeamMemberResult): string {
  return (
    result.errorMessage ||
    result.stderr.trim() ||
    getFinalOutput(result.messages).trim() ||
    "(no output)"
  );
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    return error.message.trim() || error.name;
  }
  return typeof error === "string" ? error.trim() || "Unknown error" : "Unknown error";
}

function isWriteCapableAgent(agent: AgentConfig | undefined): boolean {
  const tools = agent?.tools ?? [];
  return tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash");
}

function createWorker(
  cwd: string,
  agent: AgentConfig,
  task: string,
  phaseIndex: number,
  memberIndex: number,
  defaultModel: string | undefined,
  onUpdate: ((result: TeamMemberResult) => void) | undefined,
): RpcWorkerHandle {
  const effectiveModel = getEffectiveModel(agent, defaultModel);
  const result: TeamMemberResult = {
    agent: agent.name,
    agentSource: agent.source,
    phaseIndex,
    memberIndex,
    task,
    exitCode: 0,
    elapsedMs: 0,
    lastWork: "",
    messages: [],
    stderr: "",
    usage: createEmptyUsage(),
    model: effectiveModel,
  };

  const rpc = spawnRpcProcess(cwd, agent, defaultModel);

  const waitPromise = rpc.run(task).then((proc) => {
    result.messages = proc.messages;
    result.exitCode = proc.exitCode;
    result.stderr = proc.stderr;
    result.usage = proc.usage;
    result.model = proc.model;
    result.stopReason = proc.stopReason;
    result.errorMessage = proc.errorMessage;
    result.elapsedMs = proc.elapsedMs;
    result.lastWork = proc.lastWork;
    onUpdate?.({ ...result, usage: { ...result.usage }, messages: result.messages.map(cloneMessage) });
    return result;
  });

  return {
    result,
    waitPromise,
    abort(reason: string) {
      rpc.abort(reason);
    },
  };
}

async function runSequentialPhase(
  cwd: string,
  teamName: string,
  phase: TeamPhaseConfig,
  phaseIndex: number,
  task: string,
  agents: AgentConfig[],
  defaultModel: string | undefined,
  phaseStates: TeamPhaseState[],
  results: TeamMemberResult[],
  activeWorkers: Set<RpcWorkerHandle>,
  onUpdate: TeamUpdateCallback | undefined,
  makeDetails: () => TeamRunDetails,
  onMemberComplete: ((result: TeamMemberResult) => Promise<void>) | undefined,
): Promise<TeamPhaseRunResult> {
  const phaseResults: TeamMemberResult[] = [];

  for (let memberIndex = 0; memberIndex < phase.agentNames.length; memberIndex++) {
    const agentName = phase.agentNames[memberIndex];
    const agent = agents.find((item) => item.name === agentName);
    if (!agent) {
      return {
        ok: false,
        errorMessage: `Team "${teamName}" cannot start. Missing agent: ${agentName}.`,
        phaseResults,
      };
    }

    phaseStates[phaseIndex].members[memberIndex].status = "running";
    onUpdate?.(makeDetails());

    const worker = createWorker(
      cwd,
      agent,
      task,
      phaseIndex,
      memberIndex,
      defaultModel,
      (partial) => {
        phaseStates[phaseIndex].members[memberIndex] = {
          agent: partial.agent,
          model: partial.model,
          status:
            partial.stopReason === "error" || partial.stopReason === "aborted" || partial.errorMessage
              ? "error"
              : "running",
          elapsedMs: partial.elapsedMs,
          lastWork: partial.lastWork,
        };
        onUpdate?.(makeDetails());
      },
    );
    activeWorkers.add(worker);
    const result = await worker.waitPromise;
    activeWorkers.delete(worker);

    phaseStates[phaseIndex].members[memberIndex] = {
      agent: result.agent,
      model: result.model,
      status: isFailedMember(result) ? "error" : "done",
      elapsedMs: result.elapsedMs,
      lastWork: result.lastWork,
    };
    phaseResults.push(result);
    results.push(result);
    onUpdate?.(makeDetails());
    await onMemberComplete?.(result);

    if (isFailedMember(result)) {
      return {
        ok: false,
        errorMessage:
          `Team "${teamName}" stopped at phase ${phaseIndex + 1}, member ${memberIndex + 1} (${result.agent}): ` +
          formatMemberFailure(result),
        phaseResults,
      };
    }
  }

  return { ok: true, phaseResults };
}

async function runParallelPhase(
  cwd: string,
  teamName: string,
  phase: TeamPhaseConfig,
  phaseIndex: number,
  task: string,
  agents: AgentConfig[],
  defaultModel: string | undefined,
  phaseStates: TeamPhaseState[],
  results: TeamMemberResult[],
  activeWorkers: Set<RpcWorkerHandle>,
  onUpdate: TeamUpdateCallback | undefined,
  makeDetails: () => TeamRunDetails,
  onMemberComplete: ((result: TeamMemberResult) => Promise<void>) | undefined,
): Promise<TeamPhaseRunResult> {
  const workers = phase.agentNames.map((agentName, memberIndex) => {
    const agent = agents.find((item) => item.name === agentName);
    if (!agent) {
      throw new Error(`Team "${teamName}" cannot start. Missing agent: ${agentName}.`);
    }

    phaseStates[phaseIndex].members[memberIndex].status = "running";
    const worker = createWorker(
      cwd,
      agent,
      task,
      phaseIndex,
      memberIndex,
      defaultModel,
      (partial) => {
        phaseStates[phaseIndex].members[memberIndex] = {
          agent: partial.agent,
          model: partial.model,
          status:
            partial.stopReason === "error" || partial.stopReason === "aborted" || partial.errorMessage
              ? "error"
              : "running",
          elapsedMs: partial.elapsedMs,
          lastWork: partial.lastWork,
        };
        onUpdate?.(makeDetails());
      },
    );
    activeWorkers.add(worker);
    return worker;
  });

  onUpdate?.(makeDetails());

  const phaseResults = new Array<TeamMemberResult>(workers.length);
  const pending = new Set<number>(workers.map((_, index) => index));
  const completions = workers.map((worker, index) =>
    worker.waitPromise.then((result) => ({ index, result })),
  );

  while (pending.size > 0) {
    const { index, result } = await Promise.race(
      Array.from(pending, (pendingIndex) => completions[pendingIndex]),
    );
    pending.delete(index);
    phaseResults[index] = result;
    activeWorkers.delete(workers[index]);
    phaseStates[phaseIndex].members[index] = {
      agent: result.agent,
      model: result.model,
      status: isFailedMember(result) ? "error" : "done",
      elapsedMs: result.elapsedMs,
      lastWork: result.lastWork,
    };
    onUpdate?.(makeDetails());
    await onMemberComplete?.(result);

    if (!isFailedMember(result)) continue;

    for (const pendingIndex of pending) {
      workers[pendingIndex].abort("Aborted due to sibling failure.");
    }
    const remaining = await Promise.all(
      Array.from(pending, (pendingIndex) => completions[pendingIndex]),
    );
    for (const settled of remaining) {
      phaseResults[settled.index] = settled.result;
      activeWorkers.delete(workers[settled.index]);
      phaseStates[phaseIndex].members[settled.index] = {
        agent: settled.result.agent,
        model: settled.result.model,
        status: isFailedMember(settled.result) ? "error" : "done",
        elapsedMs: settled.result.elapsedMs,
        lastWork: settled.result.lastWork,
      };
      await onMemberComplete?.(settled.result);
    }
    onUpdate?.(makeDetails());

    for (const phaseResult of phaseResults) {
      if (phaseResult) results.push(phaseResult);
    }

    return {
      ok: false,
      errorMessage:
        `Team "${teamName}" stopped at phase ${phaseIndex + 1}, member ${index + 1} (${result.agent}): ` +
        formatMemberFailure(result),
      phaseResults: phaseResults.filter(Boolean) as TeamMemberResult[],
    };
  }

  for (const phaseResult of phaseResults) {
    results.push(phaseResult);
  }
  return { ok: true, phaseResults };
}

export async function runTeamPhases(
  cwd: string,
  team: TeamConfig,
  agents: AgentConfig[],
  task: string,
  defaultModel?: string,
  signal?: AbortSignal,
  onUpdate?: TeamUpdateCallback,
  options?: TeamRuntimeOptions,
): Promise<TeamRunResult> {
  const missingAgents = Array.from(
    new Set(
      team.phases.flatMap((phase) =>
        phase.agentNames.filter(
          (agentName) => !agents.some((agent) => agent.name === agentName),
        ),
      ),
    ),
  );
  if (missingAgents.length > 0) {
    return {
      teamName: team.name,
      teamSource: team.source,
      teamFilePath: team.filePath ?? null,
      runDir: "",
      phases: [],
      results: [],
      finalText: "",
      isError: true,
      errorMessage: `Team "${team.name}" cannot start. Missing agents: ${missingAgents.join(", ")}.`,
    };
  }

  const phaseStates = makeInitialPhaseStates(team.phases, agents, defaultModel);
  const results: TeamMemberResult[] = [];
  const phaseDoneRecords = team.phases.map(() => [] as TeamMemberDone[]);
  const activeWorkers = new Set<RpcWorkerHandle>();
  const sequentializeParallelPhases = options?.sequentializeParallelPhases ?? false;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const runId = randomUUID();
  let lock: TeamRunLock | undefined;
  let runDir = "";
  const runState = createTeamRunState(runId, team.name, task, team.phases);
  let abortedBySignal = false;
  let currentPhaseIndex = 0;
  let terminalStatus: TeamRunStatus = "failed";
  let terminalErrorMessage: string | null = null;
  let finalText = "";

  try {
    lock = acquireTeamLock(cwd, runId);
    runDir = initTeamRunDir(lock.rootDir, runId);
    writeTeamState(runDir, runState);
  } catch (error) {
    if (lock) releaseTeamLock(lock);
    return {
      teamName: team.name,
      teamSource: team.source,
      teamFilePath: team.filePath ?? null,
      runDir: "",
      phases: [],
      results: [],
      finalText: "",
      isError: true,
      errorMessage: describeUnknownError(error),
    };
  }

  const makeDetails = (): TeamRunDetails => ({
    teamName: team.name,
    teamSource: team.source,
    teamFilePath: team.filePath ?? null,
    runDir,
    phases: clonePhases(phaseStates),
    results: results.map((result) => ({
      ...result,
      usage: { ...result.usage },
      messages: result.messages.map(cloneMessage),
    })),
  });

  const getPhaseDoneResults = (phaseIndex: number): TeamMemberDone[] =>
    phaseDoneRecords[phaseIndex]
      .filter((item): item is TeamMemberDone => Boolean(item))
      .sort((left, right) => left.memberIndex - right.memberIndex);

  const persistMemberResult = async (result: TeamMemberResult): Promise<void> => {
    const doneRecord = await extractMemberDone(cwd, result, defaultModel);
    phaseDoneRecords[result.phaseIndex][result.memberIndex] = doneRecord;
    writeMemberDone(runDir, team.phases[result.phaseIndex], doneRecord);
  };

  const abortAllWorkers = (reason: string) => {
    for (const worker of activeWorkers) {
      worker.abort(reason);
    }
  };

  const onSignalAbort = () => {
    abortedBySignal = true;
    abortAllWorkers("Team run was aborted.");
  };
  if (signal) {
    if (signal.aborted) onSignalAbort();
    else signal.addEventListener("abort", onSignalAbort, { once: true });
  }

  onUpdate?.(makeDetails());

  let finalResult: TeamRunResult;
  try {
    let currentInput = task;
    let sharedState = createEmptyTeamSharedState();

    for (let phaseIndex = 0; phaseIndex < team.phases.length; phaseIndex++) {
      currentPhaseIndex = phaseIndex;
      if (abortedBySignal) {
        terminalStatus = "aborted";
        terminalErrorMessage = "Team run was aborted.";
        finalResult = {
          ...makeDetails(),
          finalText: "",
          isError: true,
          errorMessage: terminalErrorMessage,
        };
        return finalResult;
      }

      const phase = team.phases[phaseIndex];
      const sharedStateBeforePhase = sharedState;
      const hasWriteCapableAgent = phase.agentNames.some((agentName) =>
        isWriteCapableAgent(agents.find((agent) => agent.name === agentName)),
      );
      const beforeSnapshot = hasWriteCapableAgent
        ? captureTeamRepositorySnapshot(cwd)
        : undefined;
      const phaseRunner =
        phase.kind === "parallel" && !sequentializeParallelPhases
          ? runParallelPhase(
              cwd,
              team.name,
              phase,
              phaseIndex,
              currentInput,
              agents,
              defaultModel,
              phaseStates,
              results,
              activeWorkers,
              onUpdate,
              makeDetails,
              persistMemberResult,
            )
          : runSequentialPhase(
              cwd,
              team.name,
              phase,
              phaseIndex,
              currentInput,
              agents,
              defaultModel,
              phaseStates,
              results,
              activeWorkers,
              onUpdate,
              makeDetails,
              persistMemberResult,
            );

      const timedPhase = await Promise.race([
        phaseRunner.then((value) => ({ type: "result" as const, value })),
        new Promise<{ type: "timeout" }>((resolve) => {
          const timeout = setTimeout(() => {
            resolve({ type: "timeout" });
          }, timeoutMs);
          phaseRunner.finally(() => clearTimeout(timeout));
        }),
      ]);

      if (timedPhase.type === "timeout") {
        abortAllWorkers("Agent timed out.");
        await phaseRunner;
        terminalStatus = "failed";
        terminalErrorMessage =
          `Team "${team.name}" stopped at phase ${phaseIndex + 1}: an agent timed out after ${Math.round(timeoutMs / 1000)} seconds.`;
        finalResult = {
          ...makeDetails(),
          finalText: "",
          isError: true,
          errorMessage: terminalErrorMessage,
        };
        return finalResult;
      }

      const phaseDoneResults = getPhaseDoneResults(phaseIndex);
      finalText = buildPhaseHandoff(task, sharedStateBeforePhase, phaseDoneResults);

      if (beforeSnapshot) {
        const touchedFiles = collectTeamTouchedFiles(cwd, beforeSnapshot);
        const claimedArtifacts = phaseDoneResults.flatMap((done) => done.artifacts);
        if (touchedFiles.length === 0 && claimedArtifacts.length > 0) {
          phaseStates[phaseIndex].warningMessage =
            `Phase ${phaseIndex + 1}: ${PHASE_WARNING_PREFIX}`;
          onUpdate?.(makeDetails());
        }
      }

      if (!timedPhase.value.ok) {
        terminalStatus = abortedBySignal ? "aborted" : "failed";
        terminalErrorMessage = timedPhase.value.errorMessage;
        finalResult = {
          ...makeDetails(),
          finalText: "",
          isError: true,
          errorMessage: terminalErrorMessage,
        };
        return finalResult;
      }

      sharedState = mergePhaseIntoSharedState(sharedState, phaseDoneResults);
      currentInput = finalText;
    }

    terminalStatus = "completed";
    terminalErrorMessage = null;
    finalResult = {
      ...makeDetails(),
      finalText,
      isError: false,
    };
    return finalResult;
  } catch (error) {
    terminalStatus = abortedBySignal ? "aborted" : "failed";
    terminalErrorMessage = describeUnknownError(error);
    finalResult = {
      ...makeDetails(),
      finalText: "",
      isError: true,
      errorMessage: terminalErrorMessage,
    };
    return finalResult;
  } finally {
    if (signal) {
      signal.removeEventListener("abort", onSignalAbort);
    }

    runState.currentPhaseIndex = currentPhaseIndex;
    runState.status = terminalStatus;
    runState.finishedAt = new Date().toISOString();
    runState.errorMessage = terminalErrorMessage;

    try {
      writeTeamState(runDir, runState);
    } finally {
      if (lock) releaseTeamLock(lock);
    }
  }
}

export async function runTeamByName(
  cwd: string,
  teamName: string,
  task: string,
  defaultModel?: string,
  signal?: AbortSignal,
  onUpdate?: TeamUpdateCallback,
  options?: TeamRuntimeOptions,
): Promise<TeamRunResult> {
  const { agents } = discoverAgents(cwd);
  const { teams } = discoverTeams(cwd);
  const team = teams.find((item) => item.name === teamName);
  if (!team) {
    return {
      teamName,
      teamSource: "built-in",
      teamFilePath: null,
      runDir: "",
      phases: [],
      results: [],
      finalText: "",
      isError: true,
      errorMessage: `Unknown team: "${teamName}"`,
    };
  }
  return runTeamPhases(cwd, team, agents, task, defaultModel, signal, onUpdate, options);
}
