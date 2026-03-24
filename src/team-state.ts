import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TeamMemberDone } from "./team-handoff.js";
import type { TeamPhaseConfig } from "./teams.js";

export type TeamRunStatus = "running" | "completed" | "failed" | "aborted";

export interface TeamRunState {
  runId: string;
  teamName: string;
  task: string;
  status: TeamRunStatus;
  currentPhaseIndex: number;
  startedAt: string;
  finishedAt: string | null;
  errorMessage: string | null;
  phases: Array<{
    kind: "parallel" | "sequential";
    agentNames: string[];
  }>;
}

export interface TeamRunLock {
  lockFilePath: string;
  runId: string;
  rootDir: string;
}

interface RepositorySnapshot {
  dirtyFileHashes: Map<string, string | null>;
}

function sanitizeFileNamePart(input: string): string {
  return input.replace(/[^\w.-]+/g, "-");
}

function uniqueStrings(items: readonly string[]): string[] {
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

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function ensureTeamRunsRoot(cwd: string): string {
  const rootDir = path.join(cwd, ".pi", "team-runs");
  fs.mkdirSync(rootDir, { recursive: true });
  return rootDir;
}

function isTerminalStatus(status: TeamRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "aborted";
}

function readTeamRunStateFile(filePath: string): TeamRunState | undefined {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as TeamRunState;
  } catch {
    return undefined;
  }
}

function tryUnlink(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    /* ignore */
  }
}

function tryAcquireTeamLock(
  lockFilePath: string,
  runId: string,
  retried = false,
): TeamRunLock {
  try {
    const fd = fs.openSync(lockFilePath, "wx");
    try {
      fs.writeFileSync(fd, runId, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    return {
      lockFilePath,
      runId,
      rootDir: path.dirname(lockFilePath),
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as { code?: string }).code)
        : undefined;
    if (code !== "EEXIST") {
      throw error instanceof Error ? error : new Error(String(error));
    }

    let priorRunId = "";
    try {
      priorRunId = fs.readFileSync(lockFilePath, "utf8").trim();
    } catch {
      priorRunId = "";
    }

    if (!priorRunId) {
      if (retried) {
        throw new Error("Could not acquire team run lock.");
      }
      tryUnlink(lockFilePath);
      return tryAcquireTeamLock(lockFilePath, runId, true);
    }

    const priorStatePath = path.join(path.dirname(lockFilePath), priorRunId, "state.json");
    const priorState = readTeamRunStateFile(priorStatePath);
    if (!priorState) {
      if (retried) {
        throw new Error("Could not acquire team run lock.");
      }
      tryUnlink(lockFilePath);
      return tryAcquireTeamLock(lockFilePath, runId, true);
    }

    if (priorState.status === "running") {
      throw new Error(
        `A team run is already active (runId: ${priorRunId}). Wait for it to complete or delete .pi/team-runs/.lock after confirming the prior run is dead.`,
      );
    }

    if (isTerminalStatus(priorState.status)) {
      if (retried) {
        throw new Error("Could not acquire team run lock.");
      }
      tryUnlink(lockFilePath);
      return tryAcquireTeamLock(lockFilePath, runId, true);
    }

    throw new Error("Could not acquire team run lock.");
  }
}

function resolveVerifyPath(cwd: string, filePath: string): string | null {
  const resolvedPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
  const relativePath = path.relative(cwd, resolvedPath);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) return null;
  return resolvedPath;
}

function readFileDigest(filePath: string): string | null {
  try {
    const stats = fs.statSync(filePath);
    if (!stats.isFile()) return null;
    return createHash("sha1").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return null;
  }
}

function parseGitStatusPaths(stdout: string): string[] {
  const tokens = stdout.split("\0").filter(Boolean);
  const filePaths: string[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token.length < 4 || token[2] !== " ") continue;
    const status = token.slice(0, 2);
    const primaryPath = token.slice(3).trim();
    if (primaryPath) filePaths.push(primaryPath);
    if (status.includes("R") || status.includes("C")) {
      const secondaryPath = tokens[index + 1]?.trim();
      if (secondaryPath) filePaths.push(secondaryPath);
      index += 1;
    }
  }
  return uniqueStrings(filePaths);
}

export function createTeamRunState(
  runId: string,
  teamName: string,
  task: string,
  phases: TeamPhaseConfig[],
): TeamRunState {
  return {
    runId,
    teamName,
    task,
    status: "running",
    currentPhaseIndex: 0,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    errorMessage: null,
    phases: phases.map((phase) => ({
      kind: phase.kind,
      agentNames: [...phase.agentNames],
    })),
  };
}

export function acquireTeamLock(cwd: string, runId: string): TeamRunLock {
  const rootDir = ensureTeamRunsRoot(cwd);
  const lockFilePath = path.join(rootDir, ".lock");
  return tryAcquireTeamLock(lockFilePath, runId);
}

export function releaseTeamLock(lock: TeamRunLock): void {
  try {
    const currentRunId = fs.readFileSync(lock.lockFilePath, "utf8").trim();
    if (currentRunId && currentRunId !== lock.runId) return;
  } catch {
    /* ignore */
  }
  tryUnlink(lock.lockFilePath);
}

export function initTeamRunDir(rootDir: string, runId: string): string {
  const runDir = path.join(rootDir, runId);
  fs.mkdirSync(path.join(runDir, "phases"), { recursive: true });
  return runDir;
}

export function writeTeamState(runDir: string, state: TeamRunState): void {
  writeJsonFile(path.join(runDir, "state.json"), state);
}

export function writeMemberDone(
  runDir: string,
  phase: TeamPhaseConfig,
  done: TeamMemberDone,
): void {
  const phaseDir = path.join(runDir, "phases", `${done.phaseIndex}-${phase.kind}`);
  const memberDir = path.join(
    phaseDir,
    `${done.memberIndex}-${sanitizeFileNamePart(done.agent)}`,
  );
  fs.mkdirSync(memberDir, { recursive: true });
  writeJsonFile(path.join(memberDir, "done.json"), done);
}

export function captureTeamRepositorySnapshot(cwd: string): RepositorySnapshot | undefined {
  const gitStatus = spawnSync(
    "git",
    ["status", "--porcelain=v1", "--untracked-files=all", "-z"],
    { cwd, encoding: "utf8" },
  );
  if (gitStatus.status !== 0) return undefined;

  const dirtyFileHashes = new Map<string, string | null>();
  for (const filePath of parseGitStatusPaths(gitStatus.stdout ?? "")) {
    const resolvedPath = resolveVerifyPath(cwd, filePath);
    if (!resolvedPath) continue;
    dirtyFileHashes.set(filePath, readFileDigest(resolvedPath));
  }

  return { dirtyFileHashes };
}

export function collectTeamTouchedFiles(
  cwd: string,
  beforeSnapshot: RepositorySnapshot | undefined,
): string[] {
  if (!beforeSnapshot) return [];
  const afterSnapshot = captureTeamRepositorySnapshot(cwd);
  if (!afterSnapshot) return [];

  const touchedFiles: string[] = [];
  for (const [filePath, afterHash] of afterSnapshot.dirtyFileHashes.entries()) {
    const beforeHash = beforeSnapshot.dirtyFileHashes.get(filePath);
    if (!beforeSnapshot.dirtyFileHashes.has(filePath) || beforeHash !== afterHash) {
      touchedFiles.push(filePath);
    }
  }

  return uniqueStrings(touchedFiles);
}
