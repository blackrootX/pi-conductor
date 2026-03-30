import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, AgentSource } from "./agents.js";
import {
  discoverAgents,
  resolveAgentSystemPrompt,
  resolveExecutionProfile,
} from "./agents.js";
import { runWorkflowAgentSession, createSharedSessionResources, type SharedSessionResources } from "./workflow-agent-session.js";
import {
  applyOnStepErrorPatch,
  type AfterPromotePatch,
  createImmutableHookSnapshot,
  mergeAfterStepPatch,
  mergeBeforeStepPatch,
  mergeOnStepErrorPatch,
  mergeSharedStatePatch,
  type OnStepErrorPatch,
  type WorkflowRuntimeError,
  type WorkflowRuntimeErrorStage,
  type WorkflowRuntimeHooks,
} from "./workflow-hooks.js";
import { renderRepairPrompt, renderStructuredStepPrompt } from "./workflow-prompts.js";
import { parseAgentResult } from "./workflow-result.js";
import {
  buildCanonicalStepSnapshot,
  buildFinalTextFromState,
  buildPersistedWorkflowStateSnapshot,
  buildWorkOrder,
  completeWorkflowState,
  createWorkflowState,
  deriveProvisionalResult,
  markStepFailure,
  markStepRunning,
  mergeAgentResultIntoState,
  mergeBlockedAgentResultIntoState,
  recordVerificationOutcome,
  setProvisionalStepResult,
} from "./workflow-state.js";
import type {
  AgentResult,
  BlockedWorkSummaryItem,
  ExecutionProfile,
  VerificationItem,
  VerifyStatus,
  WorkflowPersistedStateSnapshot,
  WorkflowConfig,
  WorkflowState,
} from "./workflow-types.js";
import {
  applyWorkItemBatch,
  projectWorkItems,
} from "./workflow-work-items.js";
import { discoverWorkflows } from "./workflows.js";

const REPAIR_SYSTEM_PROMPT = [
  "You repair workflow step outputs into a structured result contract.",
  "Do not invent repository changes or verification that are not supported by the provided text.",
  "Preserve the most faithful interpretation of the original step output.",
  "Return the required structured result block exactly once.",
].join("\n");

const STEP_TIMEOUT_ENV = "PI_CONDUCTOR_STEP_TIMEOUT_MS";

function resolveStepTimeoutMs(): number | undefined {
  const envValue = process.env[STEP_TIMEOUT_ENV];
  if (envValue === "0" || envValue === "none" || envValue === "false") return undefined;
  if (envValue) {
    const parsed = Number.parseInt(envValue, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  task: string;
  objective?: string;
  profile?: ExecutionProfile;
  exitCode: number;
  elapsedMs: number;
  lastWork: string;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  stepId?: string;
  rawFinalText?: string;
  repairedFinalText?: string;
  parseError?: string;
  repairAttempted?: boolean;
  structuredStatus?: AgentResult["status"];
  diagnostics?: string[];
}

export interface WorkflowDetails {
  workflowName: string;
  steps: WorkflowConfig["steps"];
  workflowSource: WorkflowConfig["source"];
  workflowFilePath: string | null;
  runDir: string;
  results: SingleResult[];
  state: WorkflowState;
}

export type WorkflowUpdate = WorkflowDetails;

export interface WorkflowRunResult {
  workflowName: string;
  steps: WorkflowConfig["steps"];
  workflowSource: WorkflowConfig["source"];
  workflowFilePath: string | null;
  runDir: string;
  results: SingleResult[];
  state: WorkflowState;
  finalText: string;
  isError: boolean;
  errorMessage?: string;
}

export type WorkflowUpdateCallback = (details: WorkflowUpdate) => void;

type RunSingleAgentOptions = {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  defaultModel: string | undefined;
  step: number;
  stepId: string;
  objective: string;
  signal: AbortSignal | undefined;
  stepTimeoutMs: number | undefined;
  sharedResources: SharedSessionResources | undefined;
  onUpdate: ((result: SingleResult) => void) | undefined;
  systemPromptOverride?: string;
  toolsOverride?: string[];
};

type WorkflowPersistence = {
  runDir: string;
  stepsDir: string;
};

export function getFinalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

export function isErrorResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.structuredStatus === "failed"
  );
}

function makeEmptyUsage(): UsageStats {
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

function createPersistence(cwd: string, runId: string): WorkflowPersistence {
  const runDir = path.join(cwd, ".pi", "workflow-runs", runId);
  const stepsDir = path.join(runDir, "steps");
  fs.mkdirSync(stepsDir, { recursive: true });
  return { runDir, stepsDir };
}

function sanitizeFileNamePart(input: string): string {
  return input.replace(/[^\w.-]+/g, "-");
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeTextFile(filePath: string, text: string): void {
  fs.writeFileSync(filePath, text, "utf8");
}

type VerifyPolicy = {
  verifyOptional: boolean;
  allowClaimedChecks: boolean;
  allowFileExistsChecks: boolean;
  allowGrepChecks: boolean;
  allowWorkerSelectedFileTargets: boolean;
};

type PlannedVerifyCheck = {
  check: string;
  kind: NonNullable<VerificationItem["kind"]>;
  path?: string;
  pattern?: string;
  source: NonNullable<VerificationItem["source"]>;
  notes?: string;
};

type VerifyStepOutcome = {
  status: VerifyStatus;
  checks: VerificationItem[];
  summary: string;
};

type RepositorySnapshot = {
  dirtyFileHashes: Map<string, string | null>;
};

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

function resolveVerifyPolicy(profile: ExecutionProfile): VerifyPolicy {
  switch (profile) {
    case "planning":
    case "explore":
      return {
        verifyOptional: true,
        allowClaimedChecks: true,
        allowFileExistsChecks: true,
        allowGrepChecks: true,
        allowWorkerSelectedFileTargets: true,
      };
    case "verify-context":
      return {
        verifyOptional: false,
        allowClaimedChecks: true,
        allowFileExistsChecks: true,
        allowGrepChecks: true,
        allowWorkerSelectedFileTargets: true,
      };
    case "implement":
    default:
      return {
        verifyOptional: false,
        allowClaimedChecks: true,
        allowFileExistsChecks: true,
        allowGrepChecks: true,
        allowWorkerSelectedFileTargets: false,
      };
  }
}

function collectWorkerEvidence(result: AgentResult): {
  hintedFileTargets: string[];
  symbolTargets: string[];
  claimedChecks: VerificationItem[];
} {
  const hintedFileTargets = uniqueStrings([
    ...(result.evidenceHints?.touchedFiles ?? []),
    ...(result.evidenceHints?.artifactPaths ?? []),
    ...(result.artifacts ?? []).map((item) => item.path ?? "").filter(Boolean),
    ...(result.verification ?? []).map((item) => item.path ?? "").filter(Boolean),
  ]);
  const symbolTargets = uniqueStrings(result.evidenceHints?.symbols ?? []);
  const claimedChecks = (result.verification ?? []).map((item) => {
    const requestedKind =
      item.kind && item.kind !== "claimed"
        ? `Worker requested ${item.kind} verification; runtime recorded it as an untrusted claim only.`
        : undefined;
    const notes = [item.notes?.trim(), requestedKind].filter(Boolean).join(" ").trim();
    return {
      ...item,
      notes: notes || undefined,
      source: "worker" as const,
      kind: "claimed" as const,
    };
  });
  return { hintedFileTargets, symbolTargets, claimedChecks };
}

function resolveCheckPath(cwd: string, filePath: string): string {
  return path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
}

function resolveVerifyPath(cwd: string, filePath: string): string | null {
  const resolvedPath = resolveCheckPath(cwd, filePath);
  const relativePath = path.relative(cwd, resolvedPath);
  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }
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

function captureRepositorySnapshot(cwd: string): RepositorySnapshot | undefined {
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

function collectRuntimeTouchedFiles(
  cwd: string,
  beforeSnapshot: RepositorySnapshot | undefined,
): string[] {
  if (!beforeSnapshot) return [];
  const afterSnapshot = captureRepositorySnapshot(cwd);
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

function createVerifyChecks(
  cwd: string,
  result: AgentResult,
  policy: VerifyPolicy,
  runtimeTouchedFiles: string[],
  allowFallbackWorkerSelectedFileTargets = false,
): PlannedVerifyCheck[] {
  const { hintedFileTargets, symbolTargets, claimedChecks } = collectWorkerEvidence(result);
  const planned: PlannedVerifyCheck[] = [];
  const trustedRuntimeTargets = uniqueStrings(runtimeTouchedFiles)
    .map((fileTarget) => ({
      fileTarget,
      resolvedPath: resolveVerifyPath(cwd, fileTarget),
    }))
    .filter((item) => item.resolvedPath && fs.existsSync(item.resolvedPath))
    .map((item) => item.fileTarget);
  const candidateFileTargets: Array<{
    fileTarget: string;
    source: NonNullable<VerificationItem["source"]>;
  }> = trustedRuntimeTargets.map((fileTarget) => ({
    fileTarget,
    source: "runtime",
  }));
  const seenFileTargets = new Set(trustedRuntimeTargets);
  const hintedFileTargetSource =
    policy.allowWorkerSelectedFileTargets
      ? "runtime"
      : allowFallbackWorkerSelectedFileTargets
        ? "worker"
        : null;
  if (hintedFileTargetSource) {
    for (const fileTarget of hintedFileTargets) {
      if (!fileTarget || seenFileTargets.has(fileTarget)) continue;
      seenFileTargets.add(fileTarget);
      candidateFileTargets.push({
        fileTarget,
        source: hintedFileTargetSource,
      });
    }
  }

  if (policy.allowFileExistsChecks) {
    for (const candidate of candidateFileTargets.slice(0, 8)) {
      const { fileTarget, source } = candidate;
      const resolvedPath = resolveVerifyPath(cwd, fileTarget);
      if (!resolvedPath) continue;
      planned.push({
        check: `Path exists: ${fileTarget}`,
        kind: "file_exists",
        path: resolvedPath,
        source,
      });
    }
  }

  if (policy.allowGrepChecks && symbolTargets.length > 0 && candidateFileTargets.length > 0) {
    let grepCount = 0;
    for (const candidate of candidateFileTargets.slice(0, 4)) {
      const { fileTarget, source } = candidate;
      const resolvedPath = resolveVerifyPath(cwd, fileTarget);
      if (!resolvedPath) continue;
      for (const symbolTarget of symbolTargets.slice(0, 4)) {
        planned.push({
          check: `File contains symbol: ${symbolTarget} in ${fileTarget}`,
          kind: "grep_assertion",
          path: resolvedPath,
          pattern: symbolTarget,
          source,
        });
        grepCount += 1;
        if (grepCount >= 8) break;
      }
      if (grepCount >= 8) break;
    }
  }

  if (policy.allowClaimedChecks) {
    for (const claimedCheck of claimedChecks.slice(0, 8)) {
      const resolvedPath = claimedCheck.path
        ? resolveVerifyPath(cwd, claimedCheck.path)
        : undefined;
      planned.push({
        check: claimedCheck.check,
        kind: "claimed",
        path: resolvedPath ?? undefined,
        source: "worker",
        notes: claimedCheck.notes,
      });
    }
  }

  return planned;
}

function executeVerifyCheck(check: PlannedVerifyCheck): VerificationItem {
  if (check.kind === "claimed") {
    return {
      check: check.check,
      status: "not_run",
      notes: check.notes
        ? `Worker claim recorded for runtime review: ${check.notes}`
        : "Worker claim recorded for runtime review.",
      kind: check.kind,
      path: check.path,
      source: check.source,
    };
  }

  if (check.kind === "file_exists") {
    const exists = check.path ? fs.existsSync(check.path) : false;
    return {
      check: check.check,
      status: exists ? "pass" : "fail",
      notes: exists ? check.path : "Missing path on disk.",
      kind: check.kind,
      path: check.path,
      source: check.source,
    };
  }

  if (check.kind === "grep_assertion") {
    if (!check.path || !check.pattern) {
      return {
        check: check.check,
        status: "not_run",
        notes: "Missing grep target path or pattern.",
        kind: check.kind,
        path: check.path,
        source: check.source,
      };
    }
    try {
      const content = fs.readFileSync(check.path, "utf8");
      const matches = content.includes(check.pattern);
      return {
        check: check.check,
        status: matches ? "pass" : "fail",
        notes: matches
          ? `Found "${check.pattern}" in ${check.path}.`
          : `Did not find "${check.pattern}" in ${check.path}.`,
        kind: check.kind,
        path: check.path,
        source: check.source,
      };
    } catch (error) {
      return {
        check: check.check,
        status: "fail",
        notes: `Could not read ${check.path}: ${describeUnknownError(error)}`,
        kind: check.kind,
        path: check.path,
        source: check.source,
      };
    }
  }

  return {
    check: check.check,
    status: "not_run",
    notes: "Unsupported verification check kind.",
    kind: check.kind,
    path: check.path,
    source: check.source,
  };
}

function summarizeVerifyOutcome(status: VerifyStatus, checks: VerificationItem[]): string {
  const passCount = checks.filter((item) => item.status === "pass").length;
  const failCount = checks.filter((item) => item.status === "fail").length;
  const notRunCount = checks.filter((item) => item.status === "not_run").length;
  if (status === "skipped") {
    return `Verification skipped by runtime policy (${checks.length} selected, ${notRunCount} not_run).`;
  }
  return `Verification ${status}: ${passCount} passed, ${failCount} failed, ${notRunCount} not_run.`;
}

function verifyStep(
  cwd: string,
  result: AgentResult,
  policy: VerifyPolicy,
  repositorySnapshotBeforeStep: RepositorySnapshot | undefined,
): VerifyStepOutcome {
  const runtimeTouchedFiles = policy.allowWorkerSelectedFileTargets
    ? []
    : collectRuntimeTouchedFiles(cwd, repositorySnapshotBeforeStep);
  const plannedChecks = createVerifyChecks(
    cwd,
    result,
    policy,
    runtimeTouchedFiles,
    !policy.allowWorkerSelectedFileTargets && !repositorySnapshotBeforeStep,
  );
  const checks = plannedChecks.map(executeVerifyCheck);
  const anyFail = checks.some((item) => item.status === "fail");
  const anyPass = checks.some((item) => item.status === "pass");
  const allNotRun = checks.length > 0 && checks.every((item) => item.status === "not_run");

  let status: VerifyStatus;
  if (anyFail) {
    status = "failed";
  } else if (anyPass) {
    status = "passed";
  } else if (checks.length === 0) {
    status = policy.verifyOptional ? "skipped" : "failed";
  } else if (allNotRun) {
    status = policy.verifyOptional ? "skipped" : "failed";
  } else {
    status = "failed";
  }

  return {
    status,
    checks,
    summary: summarizeVerifyOutcome(status, checks),
  };
}

function renderBucketSection(title: string, items: string[]): string {
  return [title, "", ...(items.length > 0 ? items : ["- None"]), ""].join("\n");
}

function renderSummaryBucket(state: WorkflowState): string {
  const summary = state.shared.summary?.trim() || "(no summary yet)";
  const projection = projectWorkItems(state.shared.workItems);
  const readyItems = projection.ok
    ? projection.projection.readyWorkItems.map(
        (item) =>
          `- ${item.title} [${item.status}]${item.details ? ` (${item.details})` : ""}`,
      )
    : ["- Invalid work-item state"];
  const blockedItems = projection.ok
    ? projection.projection.blockedWorkSummary.map((item) => {
        const blockedBy =
          item.blockedByTitles?.length
            ? ` (waiting on: ${item.blockedByTitles.join(", ")})`
            : "";
        return `- ${item.title} [${item.reason}]${blockedBy}${item.details ? ` (${item.details})` : ""}`;
      })
    : projection.diagnostics.map((item) => `- ${item}`);
  return [
    "# Summary",
    "",
    summary,
    "",
    renderBucketSection("## Current Focus", [
      projection.ok
        ? projection.projection.currentFocus ?? "(no actionable focus)"
        : "(invalid work-item state)",
    ]),
    renderBucketSection("## Ready Work Items", readyItems),
    renderBucketSection("## Blocked Work Items", blockedItems),
  ]
    .join("\n")
    .trim();
}

function renderDecisionsBucket(state: WorkflowState): string {
  return [
    "# Decisions",
    "",
    ...(state.shared.decisions.length > 0
      ? state.shared.decisions.map((item) =>
          `- ${item.topic}: ${item.decision}${item.rationale ? ` (${item.rationale})` : ""}`
        )
      : ["- None"]),
  ].join("\n");
}

function renderLearningsBucket(state: WorkflowState): string {
  return ["# Learnings", "", ...(state.shared.learnings.length > 0 ? state.shared.learnings.map((item) => `- ${item}`) : ["- None"])].join("\n");
}

function renderIssuesBucket(state: WorkflowState): string {
  return [
    "# Issues",
    "",
    ...(state.shared.blockers.length > 0
      ? state.shared.blockers.map((item) =>
          `- ${item.issue}${item.needs ? ` (needs: ${item.needs})` : ""}`
        )
      : ["- None"]),
  ].join("\n");
}

function renderVerificationBucket(state: WorkflowState): string {
  return [
    "# Verification",
    "",
    ...(state.shared.verification.length > 0
      ? state.shared.verification.map((item) =>
          `- ${item.check}: ${item.status}${item.notes ? ` (${item.notes})` : ""}`
        )
      : ["- None"]),
  ].join("\n");
}

function renderProvisionalBucket(state: WorkflowState): string {
  const lines = ["# Provisional Attempts", ""];
  const provisionalSteps = state.steps.filter(
    (step) => step.provisionalResult && !step.result,
  );
  if (provisionalSteps.length === 0) {
    lines.push("- None");
    return lines.join("\n");
  }
  for (const step of provisionalSteps) {
    lines.push(`## ${step.stepId} (${step.agent})`);
    lines.push(`- status: ${step.status}`);
    lines.push(`- verify: ${step.verifyStatus ?? "pending"}`);
    if (step.verifySummary) lines.push(`- verify summary: ${step.verifySummary}`);
    if (step.provisionalResult?.summary) {
      lines.push(`- provisional summary: ${step.provisionalResult.summary}`);
    }
    if (step.diagnostics?.length) {
      lines.push(...step.diagnostics.map((item) => `- diagnostic: ${item}`));
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

function persistWorkflowBuckets(
  persistence: WorkflowPersistence,
  state: WorkflowState,
): void {
  try {
    writeTextFile(path.join(persistence.runDir, "summary.md"), `${renderSummaryBucket(state)}\n`);
    writeTextFile(path.join(persistence.runDir, "decisions.md"), `${renderDecisionsBucket(state)}\n`);
    writeTextFile(path.join(persistence.runDir, "learnings.md"), `${renderLearningsBucket(state)}\n`);
    writeTextFile(path.join(persistence.runDir, "issues.md"), `${renderIssuesBucket(state)}\n`);
    writeTextFile(path.join(persistence.runDir, "verification.md"), `${renderVerificationBucket(state)}\n`);
    writeTextFile(path.join(persistence.runDir, "provisional.md"), `${renderProvisionalBucket(state)}\n`);
  } catch {
    // Canonical JSON persistence must remain authoritative even if markdown rendering fails.
  }
}

function persistWorkflowState(
  persistence: WorkflowPersistence,
  workflow: WorkflowConfig,
  state: WorkflowState,
): void {
  try {
    writeJsonFile(
      path.join(persistence.runDir, "state.json"),
      buildPersistedWorkflowStateSnapshot(state, workflow.source, workflow.filePath ?? null),
    );
  } catch {
    // State persistence is best-effort; the workflow should not crash on disk errors.
  }
}

function persistStepResult(
  persistence: WorkflowPersistence,
  stepIndex: number,
  stepAgent: string,
  state: WorkflowState,
  result: SingleResult,
): void {
  try {
  const fileName = `${String(stepIndex + 1).padStart(2, "0")}-${sanitizeFileNamePart(stepAgent)}.result.json`;
  const stepState = state.steps[stepIndex];
  writeJsonFile(path.join(persistence.stepsDir, fileName), {
    canonicalStep: stepState ? buildCanonicalStepSnapshot(stepState) : null,
    step: result.step,
    stepId: result.stepId,
    agent: result.agent,
    agentSource: result.agentSource,
    task: result.task,
    profile: result.profile ?? stepState?.profile,
    objective: result.objective,
    exitCode: result.exitCode,
    elapsedMs: result.elapsedMs,
    structuredStatus: result.structuredStatus,
    verifyStatus: stepState?.verifyStatus,
    verifySummary: stepState?.verifySummary,
    verifyChecks: stepState?.verifyChecks ?? null,
    blockedWorkSummary: cloneBlockedWorkSummary(stepState?.blockedWorkSummary) ?? null,
    parseError: result.parseError,
    repairAttempted: result.repairAttempted,
    rawFinalText: result.rawFinalText,
    repairedFinalText: result.repairedFinalText,
    messages: result.messages,
    provisionalResult: stepState?.provisionalResult ?? null,
    evidenceHints: stepState?.evidenceHints ?? null,
    diagnostics: stepState?.diagnostics ?? result.diagnostics ?? null,
    usage: result.usage,
    model: result.model,
    stderr: result.stderr,
    errorMessage: result.errorMessage,
    lastWork: result.lastWork,
  });
  } catch {
    // Step result persistence is best-effort; the workflow should not crash on disk errors.
  }
}

function makeWorkflowDetails(
  persistence: WorkflowPersistence,
  workflow: WorkflowConfig,
  results: SingleResult[],
  state: WorkflowState,
): WorkflowDetails {
  return {
    workflowName: workflow.name,
    steps: workflow.steps,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    runDir: persistence.runDir,
    results,
    state,
  };
}

function persistRunArtifacts(
  persistence: WorkflowPersistence,
  workflow: WorkflowConfig,
  state: WorkflowState,
): void {
  persistWorkflowState(persistence, workflow, state);
  persistWorkflowBuckets(persistence, state);
}

function cloneAgentResult(result: AgentResult | undefined): AgentResult | undefined {
  if (!result) return undefined;
  return {
    ...result,
    decisions: result.decisions?.map((item) => ({ ...item })),
    artifacts: result.artifacts?.map((item) => ({ ...item })),
    learnings: result.learnings ? [...result.learnings] : undefined,
    blockers: result.blockers?.map((item) => ({ ...item })),
    verification: result.verification?.map((item) => ({ ...item })),
    newWorkItems: result.newWorkItems?.map((item) => ({
      ...item,
      blockedByTitles: item.blockedByTitles ? [...item.blockedByTitles] : undefined,
    })),
    resolvedWorkItems: result.resolvedWorkItems?.map((item) => ({ ...item })),
    evidenceHints: result.evidenceHints
      ? {
          touchedFiles: result.evidenceHints.touchedFiles
            ? [...result.evidenceHints.touchedFiles]
            : undefined,
          artifactPaths: result.evidenceHints.artifactPaths
            ? [...result.evidenceHints.artifactPaths]
            : undefined,
          symbols: result.evidenceHints.symbols
            ? [...result.evidenceHints.symbols]
            : undefined,
          commands: result.evidenceHints.commands
            ? [...result.evidenceHints.commands]
            : undefined,
        }
      : undefined,
  };
}

function cloneWorkflowStateFromSnapshot(snapshot: WorkflowPersistedStateSnapshot): WorkflowState {
  return {
    runId: snapshot.runId,
    workflowName: snapshot.workflowName,
    userTask: snapshot.userTask,
    status: snapshot.status,
    currentStepIndex: snapshot.currentStepIndex,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    shared: {
      summary: snapshot.shared.summary,
      focus: snapshot.shared.focus,
      decisions: snapshot.shared.decisions.map((item) => ({ ...item })),
      artifacts: snapshot.shared.artifacts.map((item) => ({ ...item })),
      learnings: [...snapshot.shared.learnings],
      blockers: snapshot.shared.blockers.map((item) => ({ ...item })),
      verification: snapshot.shared.verification.map((item) => ({ ...item })),
      workItems: snapshot.shared.workItems.map((item) => ({
        ...item,
        blockedBy: item.blockedBy ? [...item.blockedBy] : undefined,
      })),
    },
    steps: snapshot.steps.map((step) => ({
      stepId: step.stepId,
      agent: step.agent,
      profile: step.profile,
      objective: step.objective,
      status: step.status,
      blockedWorkSummary: cloneBlockedWorkSummary(step.blockedWorkSummary),
      verifyStatus: step.verifyStatus,
      verifySummary: step.verifySummary,
      verifyAttemptCount: (step as any).verifyAttemptCount,
      verifyChecks: (step as any).verifyChecks?.map((item: any) => ({ ...item })),
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      rawFinalText: (step as any).rawFinalText,
      repairedFinalText: (step as any).repairedFinalText,
      parseError: (step as any).parseError,
      diagnostics: (step as any).diagnostics ? [...(step as any).diagnostics] : undefined,
      evidenceHints: (step as any).evidenceHints
        ? {
            touchedFiles: (step as any).evidenceHints.touchedFiles
              ? [...(step as any).evidenceHints.touchedFiles]
              : undefined,
            artifactPaths: (step as any).evidenceHints.artifactPaths
              ? [...(step as any).evidenceHints.artifactPaths]
              : undefined,
            symbols: (step as any).evidenceHints.symbols
              ? [...(step as any).evidenceHints.symbols]
              : undefined,
            commands: (step as any).evidenceHints.commands
              ? [...(step as any).evidenceHints.commands]
              : undefined,
          }
        : undefined,
      result: step.summary
        ? {
            status:
              step.status === "blocked"
                ? "blocked"
                : step.status === "failed"
                  ? "failed"
                  : "success",
            summary: step.summary,
          }
        : undefined,
    })),
  };
}

function readWorkflowSnapshotFromDisk(
  cwd: string,
  runId: string,
): WorkflowPersistedStateSnapshot {
  const filePath = path.join(cwd, ".pi", "workflow-runs", runId, "state.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read persisted workflow state for run ${runId}: ${describeUnknownError(error)}`,
    );
  }

  const snapshot = parsed as WorkflowPersistedStateSnapshot;
  if (!snapshot || typeof snapshot !== "object" || snapshot.runId !== runId) {
    throw new Error(`Persisted workflow state for run ${runId} is invalid.`);
  }
  return snapshot;
}

function getPersistedStepResultPath(
  persistence: WorkflowPersistence,
  stepIndex: number,
  stepAgent: string,
): string {
  return path.join(
    persistence.stepsDir,
    `${String(stepIndex + 1).padStart(2, "0")}-${sanitizeFileNamePart(stepAgent)}.result.json`,
  );
}

function createReconstructedSingleResult(
  step: WorkflowState["steps"][number],
  stepIndex: number,
  model?: string,
): SingleResult {
  return {
    agent: step.agent,
    agentSource: "unknown",
    task: step.objective,
    objective: step.objective,
    profile: step.profile,
    exitCode: step.status === "failed" ? 1 : 0,
    elapsedMs: 0,
    lastWork: step.result?.summary ?? step.provisionalResult?.summary ?? "",
    messages: [],
    stderr: "",
    usage: makeEmptyUsage(),
    model,
    step: stepIndex + 1,
    stepId: step.stepId,
    rawFinalText: step.rawFinalText,
    repairedFinalText: step.repairedFinalText,
    parseError: step.parseError,
    structuredStatus:
      step.result?.status ??
      (step.status === "blocked"
        ? "blocked"
        : step.status === "failed"
          ? "failed"
          : "success"),
    diagnostics: step.diagnostics ? [...step.diagnostics] : undefined,
  };
}

function loadPersistedWorkflowRun(
  cwd: string,
  runId: string,
  workflow: WorkflowConfig,
  model?: string,
): {
  persistence: WorkflowPersistence;
  state: WorkflowState;
  results: SingleResult[];
} {
  const snapshot = readWorkflowSnapshotFromDisk(cwd, runId);
  if (snapshot.workflowName !== workflow.name) {
    throw new Error(
      `Persisted run ${runId} belongs to workflow "${snapshot.workflowName}", not "${workflow.name}".`,
    );
  }
  if (snapshot.steps.length !== workflow.steps.length) {
    throw new Error(
      `Persisted run ${runId} no longer matches the current "${workflow.name}" workflow definition.`,
    );
  }
  for (let index = 0; index < workflow.steps.length; index++) {
    const persistedStep = snapshot.steps[index];
    const workflowStep = workflow.steps[index];
    if (
      persistedStep?.stepId !== workflowStep.id ||
      persistedStep?.agent !== workflowStep.agent
    ) {
      throw new Error(
        `Persisted run ${runId} no longer matches the current "${workflow.name}" workflow step order.`,
      );
    }
  }

  const state = cloneWorkflowStateFromSnapshot(snapshot);
  const persistence = createPersistence(cwd, runId);
  const results: SingleResult[] = [];

  for (let index = 0; index < workflow.steps.length; index++) {
    const workflowStep = workflow.steps[index];
    const stateStep = state.steps[index];
    if (!stateStep) continue;

    const persistedPath = getPersistedStepResultPath(
      persistence,
      index,
      workflowStep.agent,
    );
    if (!fs.existsSync(persistedPath)) {
      if (stateStep.status !== "pending" && stateStep.status !== "running") {
        results[index] = createReconstructedSingleResult(stateStep, index, model);
      }
      continue;
    }

    const raw = JSON.parse(fs.readFileSync(persistedPath, "utf8")) as Partial<
      SingleResult & {
        verifyStatus: VerifyStatus;
        verifySummary: string;
        verifyChecks: VerificationItem[];
        blockedWorkSummary: BlockedWorkSummaryItem[];
        provisionalResult: AgentResult;
        evidenceHints: NonNullable<WorkflowState["steps"][number]["evidenceHints"]>;
        diagnostics: string[];
      }
    >;

    const loadedResult: SingleResult = {
      agent: raw.agent ?? workflowStep.agent,
      agentSource: raw.agentSource ?? "unknown",
      task: raw.task ?? stateStep.objective,
      objective: raw.objective ?? stateStep.objective,
      profile: raw.profile ?? stateStep.profile,
      exitCode: raw.exitCode ?? (stateStep.status === "failed" ? 1 : 0),
      elapsedMs: raw.elapsedMs ?? 0,
      lastWork: raw.lastWork ?? stateStep.result?.summary ?? "",
      messages: raw.messages ?? [],
      stderr: raw.stderr ?? "",
      usage: raw.usage ?? makeEmptyUsage(),
      model: raw.model ?? model,
      stopReason: raw.stopReason,
      errorMessage: raw.errorMessage,
      step: raw.step ?? index + 1,
      stepId: raw.stepId ?? workflowStep.id,
      rawFinalText: raw.rawFinalText,
      repairedFinalText: raw.repairedFinalText,
      parseError: raw.parseError,
      repairAttempted: raw.repairAttempted,
      structuredStatus: raw.structuredStatus,
      diagnostics: raw.diagnostics,
    };
    results[index] = loadedResult;

    stateStep.verifyStatus = raw.verifyStatus ?? stateStep.verifyStatus;
    stateStep.verifySummary = raw.verifySummary ?? stateStep.verifySummary;
    stateStep.verifyChecks = raw.verifyChecks
      ? raw.verifyChecks.map((item) => ({ ...item }))
      : stateStep.verifyChecks;
    stateStep.blockedWorkSummary = raw.blockedWorkSummary
      ? cloneBlockedWorkSummary(raw.blockedWorkSummary)
      : stateStep.blockedWorkSummary;
    stateStep.parseError = raw.parseError ?? stateStep.parseError;
    stateStep.evidenceHints = raw.evidenceHints
      ? {
          touchedFiles: raw.evidenceHints.touchedFiles
            ? [...raw.evidenceHints.touchedFiles]
            : undefined,
          artifactPaths: raw.evidenceHints.artifactPaths
            ? [...raw.evidenceHints.artifactPaths]
            : undefined,
          symbols: raw.evidenceHints.symbols ? [...raw.evidenceHints.symbols] : undefined,
          commands: raw.evidenceHints.commands ? [...raw.evidenceHints.commands] : undefined,
        }
      : stateStep.evidenceHints;
    stateStep.rawFinalText = raw.rawFinalText ?? stateStep.rawFinalText;
    stateStep.repairedFinalText = raw.repairedFinalText ?? stateStep.repairedFinalText;
    stateStep.diagnostics = raw.diagnostics ? [...raw.diagnostics] : stateStep.diagnostics;
    stateStep.provisionalResult = cloneAgentResult(raw.provisionalResult) ?? stateStep.provisionalResult;
    if (stateStep.status === "done" || stateStep.status === "blocked") {
      stateStep.result = cloneAgentResult(raw.provisionalResult) ?? stateStep.result;
    }
  }

  return { persistence, state, results };
}

function applyResumeClarification(
  state: WorkflowState,
  stepIndex: number,
  clarification: string,
): void {
  const step = state.steps[stepIndex];
  if (!step) return;

  const previousBlockers = step.result?.blockers ?? step.provisionalResult?.blockers;
  if (previousBlockers?.length) {
    const blockerKeys = new Set(
      previousBlockers.map((item) => `${item.issue}\u0000${item.needs ?? ""}`),
    );
    state.shared.blockers = state.shared.blockers.filter(
      (item) => !blockerKeys.has(`${item.issue}\u0000${item.needs ?? ""}`),
    );
  }

  const trimmed = clarification.trim();
  if (!trimmed) return;

  const decisionKey = `User clarification\u0000${trimmed}`;
  const existingDecisionKeys = new Set(
    state.shared.decisions.map((item) => `${item.topic}\u0000${item.decision}`),
  );
  if (!existingDecisionKeys.has(decisionKey)) {
    state.shared.decisions = [
      ...state.shared.decisions,
      {
        topic: "User clarification",
        decision: trimmed,
        rationale: `Provided while resuming workflow run ${state.runId}.`,
      },
    ];
  }

  const learning = `User clarification: ${trimmed}`;
  if (!state.shared.learnings.includes(learning)) {
    state.shared.learnings = [...state.shared.learnings, learning];
  }
}

function replaceStepResult(
  results: SingleResult[],
  stepIndex: number,
  result: SingleResult,
): void {
  results[stepIndex] = result;
}

function withStepResult(
  results: SingleResult[],
  stepIndex: number,
  result: SingleResult,
): SingleResult[] {
  const next = results.slice();
  next[stepIndex] = result;
  return next;
}

function buildStructuredStopMessage(
  result: AgentResult,
  stepNumber: number,
  agentName: string,
): string {
  const blockerDetails =
    result.blockers?.map((item) => item.issue).filter(Boolean).join("; ") ?? "";
  const suffix = blockerDetails ? ` ${blockerDetails}` : "";
  return `Workflow stopped at step ${stepNumber} (${agentName}): ${result.status}.${suffix}`.trim();
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || "Unknown error";
  }
  return "Unknown error";
}

function mergeDiagnostics(
  current: string[] | undefined,
  patch: string[] | undefined,
): string[] | undefined {
  if (!patch || patch.length === 0) return current;
  const merged = new Set<string>();
  for (const item of current ?? []) {
    const trimmed = item.trim();
    if (trimmed) merged.add(trimmed);
  }
  for (const item of patch) {
    const trimmed = item.trim();
    if (trimmed) merged.add(trimmed);
  }
  return Array.from(merged.values());
}

function cloneBlockedWorkSummary(
  items: BlockedWorkSummaryItem[] | undefined,
): BlockedWorkSummaryItem[] | undefined {
  return items?.map((item) => ({
    ...item,
    blockedByTitles: item.blockedByTitles ? [...item.blockedByTitles] : undefined,
  }));
}

function normalizeStructuredStatusForV7(result: AgentResult): {
  normalizedResult: AgentResult;
  diagnostics?: string[];
} {
  return { normalizedResult: result };
}

function createSyntheticFailureResult(options: {
  agentName: string;
  agentSource: AgentSource | "unknown";
  task: string;
  objective: string;
  step: number;
  stepId: string;
  stderr: string;
  model?: string;
}): SingleResult {
  return {
    agent: options.agentName,
    agentSource: options.agentSource,
    task: options.task,
    objective: options.objective,
    exitCode: 1,
    elapsedMs: 0,
    lastWork: "",
    messages: [],
    stderr: options.stderr,
    usage: makeEmptyUsage(),
    model: options.model,
    step: options.step,
    stepId: options.stepId,
  };
}

function markWorkflowFailed(state: WorkflowState): void {
  state.status = "failed";
  state.finishedAt = new Date().toISOString();
}

async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
  const {
    defaultCwd,
    agents,
    agentName,
    task,
    defaultModel,
    step,
    stepId,
    objective,
    signal,
    stepTimeoutMs,
    sharedResources,
    onUpdate,
    systemPromptOverride,
    toolsOverride,
  } = options;

  const agent = agents.find((item) => item.name === agentName);
  if (!agent) {
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      objective,
      exitCode: 1,
      elapsedMs: 0,
      lastWork: "",
      messages: [],
      stderr: `Unknown agent: "${agentName}"`,
      usage: makeEmptyUsage(),
      step,
      stepId,
    };
  }

  let stepSignal = signal;
  let stepTimeoutId: ReturnType<typeof setTimeout> | undefined;

  if (stepTimeoutMs !== undefined && stepTimeoutMs > 0) {
    const controller = new AbortController();
    stepTimeoutId = setTimeout(() => controller.abort(), stepTimeoutMs);
    if (signal) {
      signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    stepSignal = controller.signal;
  }

  try {
    const result = await runWorkflowAgentSession({
      cwd: defaultCwd,
      agent,
      task,
      defaultModel,
      step,
      stepId,
      objective,
      signal: stepSignal,
      onUpdate,
      systemPromptOverride,
      toolsOverride,
      sharedResources,
    });

    if (stepTimeoutId !== undefined && stepSignal?.aborted && !signal?.aborted) {
      result.exitCode = 1;
      result.stopReason = "error";
      result.errorMessage = `Step timed out after ${Math.round(stepTimeoutMs! / 1000)}s`;
    }

    return result;
  } finally {
    if (stepTimeoutId !== undefined) clearTimeout(stepTimeoutId);
  }
}

type FailStepContext = {
  cwd: string;
  workflow: WorkflowConfig;
  persistence: WorkflowPersistence;
  state: WorkflowState;
  results: SingleResult[];
  defaultModel: string | undefined;
  task: string;
  hooks: WorkflowRuntimeHooks;
  emitDetails: (partialResults?: SingleResult[]) => void;
};

type FailStepOptions = {
  index: number;
  step: WorkflowConfig["steps"][number];
  agent: AgentConfig | undefined;
  workOrder?: ReturnType<typeof buildWorkOrder>;
  stage: WorkflowRuntimeErrorStage;
  error: unknown;
  resultRecord?: SingleResult;
  rawFinalText?: string;
  repairedFinalText?: string;
  parseError?: string;
  messagePrefix: string;
};

async function failStepAndReturn(
  ctx: FailStepContext,
  options: FailStepOptions,
): Promise<WorkflowRunResult> {
  const {
    index,
    step,
    agent,
    workOrder,
    stage,
    error,
    rawFinalText,
    repairedFinalText,
    parseError,
    messagePrefix,
  } = options;

  const workflowError: WorkflowRuntimeError = {
    stage,
    workflowName: ctx.workflow.name,
    stepIndex: index,
    stepId: step.id,
    agent: step.agent,
    message: describeUnknownError(error),
    stderr: options.resultRecord?.stderr,
    rawFinalText,
    repairedFinalText,
    parseError,
  };

  let errorPatch: OnStepErrorPatch | undefined;
  if (ctx.hooks.onStepError) {
    try {
      const patch = await ctx.hooks.onStepError({
        cwd: ctx.cwd,
        workflow: createImmutableHookSnapshot(ctx.workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(ctx.state),
        stepIndex: index,
        workOrder: workOrder
          ? createImmutableHookSnapshot(workOrder)
          : undefined,
        error: createImmutableHookSnapshot(workflowError),
      });
      errorPatch = patch ?? undefined;
    } catch (hookError) {
      errorPatch = mergeOnStepErrorPatch(undefined, {
        diagnostics: [`onStepError hook failed: ${describeUnknownError(hookError)}`],
      });
    }
  }

  applyOnStepErrorPatch(ctx.state, index, errorPatch);

  const failureResult =
    options.resultRecord ??
    createSyntheticFailureResult({
      agentName: step.agent,
      agentSource: agent?.source ?? "unknown",
      task: workOrder ? renderStructuredStepPrompt(workOrder) : ctx.task,
      objective: workOrder?.objective ?? ctx.state.steps[index]?.objective ?? "",
      step: index + 1,
      stepId: step.id,
      stderr: workflowError.message,
      model: agent?.model ?? ctx.defaultModel,
    });

  failureResult.objective = workOrder?.objective ?? failureResult.objective;
  failureResult.profile = workOrder?.profile ?? failureResult.profile;
  failureResult.rawFinalText = rawFinalText ?? failureResult.rawFinalText;
  failureResult.repairedFinalText =
    repairedFinalText ?? failureResult.repairedFinalText;
  failureResult.parseError = parseError ?? failureResult.parseError;
  failureResult.diagnostics = mergeDiagnostics(
    failureResult.diagnostics,
    errorPatch?.diagnostics,
  );
  if (errorPatch?.summary?.trim()) {
    failureResult.lastWork = errorPatch.summary.trim();
  }

  markStepFailure(ctx.state, index, "failed");
  replaceStepResult(ctx.results, index, failureResult);
  persistStepResult(
    ctx.persistence,
    index,
    step.agent,
    ctx.state,
    failureResult,
  );
  persistRunArtifacts(ctx.persistence, ctx.workflow, ctx.state);
  ctx.emitDetails();

  return {
    workflowName: ctx.workflow.name,
    steps: ctx.workflow.steps,
    workflowSource: ctx.workflow.source,
    workflowFilePath: ctx.workflow.filePath ?? null,
    runDir: ctx.persistence.runDir,
    results: ctx.results,
    state: ctx.state,
    finalText: "",
    isError: true,
    errorMessage: `${messagePrefix}: ${workflowError.message}`,
  };
}

async function runWorkflowWithPreparedState(options: {
  cwd: string;
  workflow: WorkflowConfig;
  agents: AgentConfig[];
  task: string;
  state: WorkflowState;
  initialResults?: SingleResult[];
  startStepIndex?: number;
  runBeforeWorkflowHook?: boolean;
  emitInitialDetails?: boolean;
  defaultModel?: string;
  stepTimeoutMs?: number;
  signal?: AbortSignal;
  onUpdate?: WorkflowUpdateCallback;
  runtimeHooks?: WorkflowRuntimeHooks;
}): Promise<WorkflowRunResult> {
  const {
    cwd,
    workflow,
    agents,
    task,
    state,
    initialResults = [],
    startStepIndex = 0,
    runBeforeWorkflowHook = true,
    emitInitialDetails = false,
    defaultModel,
    stepTimeoutMs,
    signal,
    onUpdate,
    runtimeHooks = {},
  } = options;
  const persistence = createPersistence(cwd, state.runId);
  const results = initialResults.slice();
  const hooks = runtimeHooks;
  const sharedResources = createSharedSessionResources(cwd);

  const emitDetails = (partialResults = results) => {
    onUpdate?.(makeWorkflowDetails(persistence, workflow, partialResults, state));
  };

  if (emitInitialDetails) emitDetails();

  const runOnVerifyFailureHook = async (
    input: Parameters<NonNullable<WorkflowRuntimeHooks["onVerifyFailure"]>>[0],
  ): Promise<OnStepErrorPatch | undefined> => {
    if (!hooks.onVerifyFailure) return undefined;
    try {
      const patch = await hooks.onVerifyFailure(input);
      return patch ?? undefined;
    } catch (hookError) {
      return mergeOnStepErrorPatch(undefined, {
        diagnostics: [`onVerifyFailure hook failed: ${describeUnknownError(hookError)}`],
      });
    }
  };

  const failCtx: FailStepContext = {
    cwd,
    workflow,
    persistence,
    state,
    results,
    defaultModel,
    task,
    hooks,
    emitDetails,
  };

  if (runBeforeWorkflowHook) {
    try {
      const beforeWorkflowPatch = await hooks.beforeWorkflow?.({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agents: createImmutableHookSnapshot(agents),
        defaultModel,
        state: createImmutableHookSnapshot(state),
      });
      if (beforeWorkflowPatch?.shared) {
        state.shared = mergeSharedStatePatch(state.shared, beforeWorkflowPatch.shared);
      }
    } catch (error) {
      markWorkflowFailed(state);
      persistRunArtifacts(persistence, workflow, state);
      emitDetails();
      return {
        workflowName: workflow.name,
        steps: workflow.steps,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        runDir: persistence.runDir,
        results,
        state,
        finalText: "",
        isError: true,
        errorMessage: `Workflow "${workflow.name}" could not start: ${describeUnknownError(error)}`,
      };
    }
  }

  persistRunArtifacts(persistence, workflow, state);

  for (let index = startStepIndex; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    const agent = agents.find((item) => item.name === step.agent);
    const profileResolution = resolveExecutionProfile(step, agent);
    const profile = profileResolution.resolvedProfile;
    const verifyPolicy = resolveVerifyPolicy(profile);
    const systemPromptOverride = agent
      ? resolveAgentSystemPrompt(agent, profile)
      : undefined;
    const currentProjection = projectWorkItems(state.shared.workItems);
    if (!currentProjection.ok) {
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        stage: "beforeStep",
        error: currentProjection.diagnostics.join(" "),
        messagePrefix: `Workflow stopped before step ${index + 1} (${step.agent}) due to invalid work-item state`,
      });
    }
    let workOrder = buildWorkOrder(state, step, agent, index, profile);
    state.steps[index].profile = profile;
    state.steps[index].objective = workOrder.objective;
    markStepRunning(state, index);
    persistRunArtifacts(persistence, workflow, state);
    emitDetails();

    try {
      const beforeStepPatch = await hooks.beforeStep?.({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(state),
        stepIndex: index,
        workOrder: createImmutableHookSnapshot(workOrder),
      });
      workOrder = mergeBeforeStepPatch(workOrder, beforeStepPatch ?? undefined);
    } catch (error) {
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "beforeStep",
        error,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during beforeStep hook`,
      });
    }

    state.steps[index].objective = workOrder.objective;
    persistRunArtifacts(persistence, workflow, state);
    emitDetails();

    const repositorySnapshotBeforeStep = verifyPolicy.allowWorkerSelectedFileTargets
      ? undefined
      : captureRepositorySnapshot(cwd);
    const stepPrompt = renderStructuredStepPrompt(workOrder);

    let primaryResult: SingleResult;
    try {
      primaryResult = await runSingleAgent({
        defaultCwd: cwd,
        agents,
        agentName: step.agent,
        task: stepPrompt,
        defaultModel,
        step: index + 1,
        stepId: step.id,
        objective: workOrder.objective,
        signal,
        stepTimeoutMs,
        sharedResources,
        onUpdate: onUpdate
          ? (partialResult) => {
              partialResult.profile = profile;
              emitDetails(withStepResult(results, index, partialResult));
            }
          : undefined,
        systemPromptOverride,
        toolsOverride: workOrder.allowedTools,
      });
    } catch (error) {
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "agent",
        error,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    const rawFinalText = getFinalOutput(primaryResult.messages);
    primaryResult.profile = profile;
    primaryResult.rawFinalText = rawFinalText;
    primaryResult.objective = workOrder.objective;

    if (
      primaryResult.exitCode !== 0 ||
      primaryResult.stopReason === "error" ||
      primaryResult.stopReason === "aborted"
    ) {
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "agent",
        error:
          primaryResult.errorMessage ||
          primaryResult.stderr ||
          rawFinalText ||
          "(no output)",
        resultRecord: primaryResult,
        rawFinalText,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    let parseOutcome = parseAgentResult(rawFinalText);
    let finalResultRecord = primaryResult;
    let repairedFinalText: string | undefined;
    let parseError: string | undefined;

    if (!parseOutcome.ok) {
      parseError = parseOutcome.error;
      state.steps[index].parseError = parseError;
      persistRunArtifacts(persistence, workflow, state);
      emitDetails();

      let repairResult: SingleResult;
      try {
        repairResult = await runSingleAgent({
          defaultCwd: cwd,
          agents,
          agentName: step.agent,
          task: renderRepairPrompt(rawFinalText, parseError),
          defaultModel,
          step: index + 1,
          stepId: step.id,
          objective: `${workOrder.objective} (repair structured output)`,
          signal,
          stepTimeoutMs,
          sharedResources,
          onUpdate: onUpdate
            ? (partialResult) => {
                partialResult.parseError = parseError;
                partialResult.repairAttempted = true;
                partialResult.rawFinalText = rawFinalText;
                partialResult.profile = profile;
                emitDetails(withStepResult(results, index, partialResult));
              }
            : undefined,
          systemPromptOverride: REPAIR_SYSTEM_PROMPT,
          toolsOverride: [],
        });
      } catch (error) {
        return await failStepAndReturn(failCtx, {
          index,
          step,
          agent,
          workOrder,
          stage: "repair",
          error,
          rawFinalText,
          parseError,
          messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during structured output repair`,
        });
      }

      repairedFinalText = getFinalOutput(repairResult.messages);
      repairResult.rawFinalText = rawFinalText;
      repairResult.repairedFinalText = repairedFinalText;
      repairResult.parseError = parseError;
      repairResult.repairAttempted = true;
      repairResult.objective = workOrder.objective;
      repairResult.profile = profile;
      finalResultRecord = repairResult;

      if (
        repairResult.exitCode !== 0 ||
        repairResult.stopReason === "error" ||
        repairResult.stopReason === "aborted"
      ) {
        return await failStepAndReturn(failCtx, {
          index,
          step,
          agent,
          workOrder,
          stage: "repair",
          error:
            repairResult.errorMessage ||
            repairResult.stderr ||
            repairedFinalText ||
            "(no output)",
          resultRecord: repairResult,
          rawFinalText,
          repairedFinalText,
          parseError,
          messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during structured output repair`,
        });
      }

      parseOutcome = parseAgentResult(repairedFinalText);
    }

    if (!parseOutcome.ok) {
      finalResultRecord.parseError = parseOutcome.error;
      finalResultRecord.repairAttempted = true;
      finalResultRecord.rawFinalText = rawFinalText;
      finalResultRecord.repairedFinalText = repairedFinalText;
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "parse",
        error: parseOutcome.error,
        resultRecord: finalResultRecord,
        rawFinalText,
        repairedFinalText,
        parseError: parseOutcome.error,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    let structuredResult = parseOutcome.result;
    try {
      const afterStepPatch = await hooks.afterStep?.({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(state),
        stepIndex: index,
        workOrder: createImmutableHookSnapshot(workOrder),
        result: createImmutableHookSnapshot(structuredResult),
      });
      structuredResult = mergeAfterStepPatch(
        structuredResult,
        afterStepPatch ?? undefined,
      );
    } catch (error) {
      finalResultRecord.structuredStatus = structuredResult.status;
      finalResultRecord.rawFinalText = rawFinalText;
      finalResultRecord.repairedFinalText = repairedFinalText;
      finalResultRecord.parseError = parseError;
      finalResultRecord.repairAttempted = Boolean(parseError);
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "afterStep",
        error,
        resultRecord: finalResultRecord,
        rawFinalText,
        repairedFinalText,
        parseError,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during afterStep hook`,
      });
    }

    const normalizedStatus = normalizeStructuredStatusForV7(structuredResult);
    structuredResult = normalizedStatus.normalizedResult;

    const provisionalResult = deriveProvisionalResult(structuredResult);
    setProvisionalStepResult(
      state,
      index,
      provisionalResult,
      rawFinalText,
      repairedFinalText,
      parseError,
    );

    finalResultRecord.profile = profile;
    finalResultRecord.structuredStatus = provisionalResult.status;
    finalResultRecord.rawFinalText = rawFinalText;
    finalResultRecord.repairedFinalText = repairedFinalText;
    finalResultRecord.parseError = parseError;
    finalResultRecord.repairAttempted = Boolean(parseError);
    finalResultRecord.lastWork = provisionalResult.summary;
    state.steps[index].diagnostics = mergeDiagnostics(
      state.steps[index].diagnostics,
      normalizedStatus.diagnostics,
    );
    finalResultRecord.diagnostics = mergeDiagnostics(
      finalResultRecord.diagnostics,
      normalizedStatus.diagnostics,
    );

    if (provisionalResult.status === "blocked") {
      finalResultRecord.structuredStatus = "blocked";
      finalResultRecord.lastWork = provisionalResult.summary;
      recordVerificationOutcome(
        state,
        index,
        "skipped",
        provisionalResult.verification,
        "Step reported blocked and is waiting for clarification or another unblock action.",
        0,
      );
      mergeBlockedAgentResultIntoState(
        state,
        index,
        provisionalResult,
        rawFinalText,
        repairedFinalText,
        parseError,
      );
      replaceStepResult(results, index, finalResultRecord);
      persistStepResult(persistence, index, step.agent, state, finalResultRecord);
      persistRunArtifacts(persistence, workflow, state);
      emitDetails();
      return {
        workflowName: workflow.name,
        steps: workflow.steps,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        runDir: persistence.runDir,
        results,
        state,
        finalText: buildFinalTextFromState(state),
        isError: false,
      };
    }

    const workItemMutation = applyWorkItemBatch({
      currentWorkItems: state.shared.workItems,
      newWorkItems: provisionalResult.newWorkItems,
      resolvedWorkItems: provisionalResult.resolvedWorkItems,
      stepId: step.id,
      agentName: step.agent,
      updatedAt: new Date().toISOString(),
    });

    if (!workItemMutation.ok) {
      const validationDiagnostics = workItemMutation.diagnostics;
      finalResultRecord.structuredStatus = "failed";
      state.steps[index].diagnostics = mergeDiagnostics(
        state.steps[index].diagnostics,
        validationDiagnostics,
      );
      finalResultRecord.diagnostics = mergeDiagnostics(
        finalResultRecord.diagnostics,
        validationDiagnostics,
      );
      recordVerificationOutcome(
        state,
        index,
        "failed",
        undefined,
        "Promotion denied because the combined work-item batch failed validation.",
        0,
      );
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "afterStep",
        error: validationDiagnostics.join(" "),
        resultRecord: finalResultRecord,
        rawFinalText,
        repairedFinalText,
        parseError,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) due to invalid work-item authoring`,
      });
    }

    if (provisionalResult.status === "failed") {
      recordVerificationOutcome(
        state,
        index,
        "failed",
        undefined,
        "Promotion denied because the worker reported a non-success step outcome.",
        0,
      );
      return await failStepAndReturn(failCtx, {
        index,
        step,
        agent,
        workOrder,
        stage: "verify",
        error: buildStructuredStopMessage(provisionalResult, index + 1, step.agent),
        resultRecord: finalResultRecord,
        rawFinalText,
        repairedFinalText,
        parseError,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    const verifyOutcome = verifyStep(
      cwd,
      provisionalResult,
      verifyPolicy,
      repositorySnapshotBeforeStep,
    );
    recordVerificationOutcome(
      state,
      index,
      verifyOutcome.status,
      verifyOutcome.checks,
      verifyOutcome.summary,
      1,
    );

    if (verifyOutcome.status === "failed") {
      const verifyFailurePatch = await runOnVerifyFailureHook({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(state),
        stepIndex: index,
        workOrder: createImmutableHookSnapshot(workOrder),
        result: createImmutableHookSnapshot(provisionalResult),
        verification: createImmutableHookSnapshot(verifyOutcome.checks),
        verifySummary: verifyOutcome.summary,
      });
      applyOnStepErrorPatch(state, index, verifyFailurePatch);
      finalResultRecord.diagnostics = mergeDiagnostics(
        finalResultRecord.diagnostics,
        verifyFailurePatch?.diagnostics,
      );
      if (verifyFailurePatch?.summary?.trim()) {
        finalResultRecord.lastWork = verifyFailurePatch.summary.trim();
      } else {
        finalResultRecord.lastWork = verifyOutcome.summary;
      }
      markStepFailure(state, index, "failed");
      replaceStepResult(results, index, finalResultRecord);
      persistStepResult(persistence, index, step.agent, state, finalResultRecord);
      persistRunArtifacts(persistence, workflow, state);
      emitDetails();
      return {
        workflowName: workflow.name,
        steps: workflow.steps,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        runDir: persistence.runDir,
        results,
        state,
        finalText: "",
        isError: true,
        errorMessage: `Workflow stopped at step ${index + 1} (${step.agent}) during verify: ${verifyOutcome.summary}`,
      };
    }

    const promotedResult: AgentResult = {
      ...provisionalResult,
      verification: verifyOutcome.checks,
    };
    mergeAgentResultIntoState(
      state,
      index,
      promotedResult,
      rawFinalText,
      repairedFinalText,
      parseError,
      workItemMutation,
    );

    let afterPromotePatch: AfterPromotePatch | undefined;
    try {
      afterPromotePatch = await hooks.afterPromote?.({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(state),
        stepIndex: index,
        workOrder: createImmutableHookSnapshot(workOrder),
        result: createImmutableHookSnapshot(promotedResult),
      }) ?? undefined;
    } catch (error) {
      afterPromotePatch = {
        diagnostics: [`afterPromote hook failed: ${describeUnknownError(error)}`],
      };
    }

    state.steps[index].diagnostics = mergeDiagnostics(
      state.steps[index].diagnostics,
      afterPromotePatch?.diagnostics,
    );
    finalResultRecord.diagnostics = mergeDiagnostics(
      finalResultRecord.diagnostics,
      afterPromotePatch?.diagnostics,
    );
    finalResultRecord.lastWork = promotedResult.summary;

    if (
      workItemMutation.projection.unresolvedWorkItems.length > 0 &&
      workItemMutation.projection.readyWorkItems.length === 0
    ) {
      const blockedDiagnostics = [
        "Workflow blocked because unresolved canonical work exists but no ready work items remain.",
      ];
      state.steps[index].diagnostics = mergeDiagnostics(
        state.steps[index].diagnostics,
        blockedDiagnostics,
      );
      state.steps[index].blockedWorkSummary = cloneBlockedWorkSummary(
        workItemMutation.projection.blockedWorkSummary,
      );
      finalResultRecord.diagnostics = mergeDiagnostics(
        finalResultRecord.diagnostics,
        blockedDiagnostics,
      );
      finalResultRecord.lastWork =
        "Workflow blocked because no ready work items remain.";
      markStepFailure(state, index, "blocked");
      replaceStepResult(results, index, finalResultRecord);
      persistStepResult(persistence, index, step.agent, state, finalResultRecord);
      persistRunArtifacts(persistence, workflow, state);
      emitDetails();
      return {
        workflowName: workflow.name,
        steps: workflow.steps,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        runDir: persistence.runDir,
        results,
        state,
        finalText: buildFinalTextFromState(state),
        isError: false,
      };
    }

    replaceStepResult(results, index, finalResultRecord);
    persistStepResult(persistence, index, step.agent, state, finalResultRecord);
    persistRunArtifacts(persistence, workflow, state);
    emitDetails();
  }

  completeWorkflowState(state);
  persistRunArtifacts(persistence, workflow, state);

  return {
    workflowName: workflow.name,
    steps: workflow.steps,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    runDir: persistence.runDir,
    results,
    state,
    finalText: buildFinalTextFromState(state),
    isError: false,
  };
}

export async function runWorkflowByName(
  cwd: string,
  workflowName: string,
  task: string,
  defaultModel?: string,
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdateCallback,
  runtimeHooks: WorkflowRuntimeHooks = {},
  runId = randomUUID(),
): Promise<WorkflowRunResult> {
  const { agents } = discoverAgents(cwd);
  const { workflows } = discoverWorkflows(cwd);
  const workflow = workflows.find((item) => item.name === workflowName);

  if (!workflow) {
    return {
      workflowName,
      steps: [],
      workflowSource: "built-in",
      workflowFilePath: null,
      runDir: "",
      results: [],
      state: createWorkflowState(
        { name: workflowName, steps: [], source: "built-in" },
        task,
        runId,
      ),
      finalText: "",
      isError: true,
      errorMessage: `Unknown workflow: "${workflowName}"`,
    };
  }

  const missingAgents = workflow.steps
    .map((step) => step.agent)
    .filter((agentName) => !agents.some((agent) => agent.name === agentName));
  if (missingAgents.length > 0) {
    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      runDir: "",
      results: [],
      state: createWorkflowState(workflow, task, runId),
      finalText: "",
      isError: true,
      errorMessage: `Workflow "${workflow.name}" cannot start. Missing agents: ${missingAgents.join(", ")}.`,
    };
  }

  return runWorkflowWithPreparedState({
    cwd,
    workflow,
    agents,
    task,
    state: createWorkflowState(workflow, task, runId),
    defaultModel,
    stepTimeoutMs: resolveStepTimeoutMs(),
    signal,
    onUpdate,
    runtimeHooks,
  });
}

export async function resumeWorkflowRun(
  cwd: string,
  runId: string,
  clarification: string,
  defaultModel?: string,
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdateCallback,
  runtimeHooks: WorkflowRuntimeHooks = {},
): Promise<WorkflowRunResult> {
  const runDir = path.join(cwd, ".pi", "workflow-runs", runId);
  let snapshot: WorkflowPersistedStateSnapshot;
  try {
    snapshot = readWorkflowSnapshotFromDisk(cwd, runId);
  } catch (error) {
    return {
      workflowName: `resume:${runId}`,
      steps: [],
      workflowSource: "built-in",
      workflowFilePath: null,
      runDir,
      results: [],
      state: createWorkflowState(
        { name: `resume:${runId}`, steps: [], source: "built-in" },
        clarification,
        runId,
      ),
      finalText: "",
      isError: true,
      errorMessage: describeUnknownError(error),
    };
  }

  const { workflows } = discoverWorkflows(cwd);
  const workflow = workflows.find((item) => item.name === snapshot.workflowName);
  if (!workflow) {
    const state = cloneWorkflowStateFromSnapshot(snapshot);
    return {
      workflowName: snapshot.workflowName,
      steps: [],
      workflowSource: snapshot.workflowSource,
      workflowFilePath: snapshot.workflowFilePath ?? null,
      runDir,
      results: [],
      state,
      finalText: "",
      isError: true,
      errorMessage: `Persisted workflow "${snapshot.workflowName}" is no longer available for resume.`,
    };
  }

  const { agents } = discoverAgents(cwd);
  const missingAgents = workflow.steps
    .map((step) => step.agent)
    .filter((agentName) => !agents.some((agent) => agent.name === agentName));
  if (missingAgents.length > 0) {
    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      runDir,
      results: [],
      state: cloneWorkflowStateFromSnapshot(snapshot),
      finalText: "",
      isError: true,
      errorMessage: `Workflow "${workflow.name}" cannot resume. Missing agents: ${missingAgents.join(", ")}.`,
    };
  }

  let loaded;
  try {
    loaded = loadPersistedWorkflowRun(cwd, runId, workflow, defaultModel);
  } catch (error) {
    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      runDir,
      results: [],
      state: cloneWorkflowStateFromSnapshot(snapshot),
      finalText: "",
      isError: true,
      errorMessage: describeUnknownError(error),
    };
  }

  const state = loaded.state;
  const blockedStepIndex = state.currentStepIndex;
  const blockedStep = state.steps[blockedStepIndex];
  if (state.status !== "blocked" || !blockedStep || blockedStep.status !== "blocked") {
    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      runDir,
      results: loaded.results,
      state,
      finalText: buildFinalTextFromState(state),
      isError: true,
      errorMessage: `Workflow run ${runId} is not paused on a blocked step and cannot be resumed.`,
    };
  }

  applyResumeClarification(state, blockedStepIndex, clarification);

  return runWorkflowWithPreparedState({
    cwd,
    workflow,
    agents,
    task: state.userTask,
    state,
    initialResults: loaded.results,
    startStepIndex: blockedStepIndex,
    runBeforeWorkflowHook: false,
    emitInitialDetails: true,
    defaultModel,
    stepTimeoutMs: resolveStepTimeoutMs(),
    signal,
    onUpdate,
    runtimeHooks,
  });
}
