import type { AgentConfig } from "./agents.js";
import type {
  AgentResult,
  ArtifactItem,
  BlockerItem,
  DecisionItem,
  EvidenceHints,
  NewWorkItemInput,
  ResolvedWorkItemInput,
  SharedState,
  VerificationItem,
  WorkItem,
  WorkflowChannel,
  WorkflowConfig,
  WorkflowState,
  WorkOrder,
} from "./workflow-types.js";

type MaybePromise<T> = T | Promise<T>;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? ReadonlyArray<DeepReadonly<Item>>
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export interface SharedStatePatch {
  summary?: string | null;
  focus?: string | null;
  decisions?: DecisionItem[];
  artifacts?: ArtifactItem[];
  learnings?: string[];
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
}

export interface WorkOrderContextPatch {
  summary?: string | null;
  decisions?: DecisionItem[];
  artifacts?: ArtifactItem[];
  learnings?: string[];
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
  recentResolvedWorkItems?: WorkItem[];
}

export interface BeforeWorkflowInput {
  cwd: string;
  workflow: DeepReadonly<WorkflowConfig>;
  agents: ReadonlyArray<DeepReadonly<AgentConfig>>;
  defaultModel?: string;
  state: DeepReadonly<WorkflowState>;
}

export interface BeforeWorkflowPatch {
  shared?: SharedStatePatch;
}

export interface BeforeStepInput {
  cwd: string;
  workflow: DeepReadonly<WorkflowConfig>;
  agent?: DeepReadonly<AgentConfig>;
  state: DeepReadonly<WorkflowState>;
  stepIndex: number;
  workOrder: DeepReadonly<WorkOrder>;
}

export interface BeforeStepPatch {
  objective?: string | null;
  agentDescription?: string | null;
  constraints?: string[];
  profileGuidance?: string[];
  allowedTools?: string[];
  definitionOfDone?: string[];
  requiredEvidence?: string[];
  expectedOutput?: WorkflowChannel[];
  context?: WorkOrderContextPatch;
}

export interface AfterStepInput {
  cwd: string;
  workflow: DeepReadonly<WorkflowConfig>;
  agent?: DeepReadonly<AgentConfig>;
  state: DeepReadonly<WorkflowState>;
  stepIndex: number;
  workOrder: DeepReadonly<WorkOrder>;
  result: DeepReadonly<AgentResult>;
}

export interface AfterStepPatch {
  status?: AgentResult["status"];
  summary?: string | null;
  decisions?: DecisionItem[];
  artifacts?: ArtifactItem[];
  learnings?: string[];
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
  newWorkItems?: NewWorkItemInput[];
  resolvedWorkItems?: ResolvedWorkItemInput[];
  focusSummary?: string | null;
  nextStepHint?: string | null;
  evidenceHints?: EvidenceHints;
}

export type WorkflowRuntimeErrorStage =
  | "beforeWorkflow"
  | "beforeStep"
  | "agent"
  | "repair"
  | "parse"
  | "afterStep"
  | "verify";

export interface WorkflowRuntimeError {
  stage: WorkflowRuntimeErrorStage;
  workflowName: string;
  stepIndex?: number;
  stepId?: string;
  agent?: string;
  message: string;
  stderr?: string;
  rawFinalText?: string;
  repairedFinalText?: string;
  parseError?: string;
}

export interface OnStepErrorInput {
  cwd: string;
  workflow: DeepReadonly<WorkflowConfig>;
  agent?: DeepReadonly<AgentConfig>;
  state: DeepReadonly<WorkflowState>;
  stepIndex: number;
  workOrder?: DeepReadonly<WorkOrder>;
  error: DeepReadonly<WorkflowRuntimeError>;
}

export interface OnStepErrorPatch {
  summary?: string | null;
  focus?: string | null;
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
  diagnostics?: string[];
}

export interface AfterPromoteInput {
  cwd: string;
  workflow: DeepReadonly<WorkflowConfig>;
  agent?: DeepReadonly<AgentConfig>;
  state: DeepReadonly<WorkflowState>;
  stepIndex: number;
  workOrder: DeepReadonly<WorkOrder>;
  result: DeepReadonly<AgentResult>;
}

export interface AfterPromotePatch {
  diagnostics?: string[];
}

export interface OnVerifyFailureInput {
  cwd: string;
  workflow: DeepReadonly<WorkflowConfig>;
  agent?: DeepReadonly<AgentConfig>;
  state: DeepReadonly<WorkflowState>;
  stepIndex: number;
  workOrder: DeepReadonly<WorkOrder>;
  result: DeepReadonly<AgentResult>;
  verification: DeepReadonly<VerificationItem[]>;
  verifySummary?: string;
}

export type OnVerifyFailurePatch = OnStepErrorPatch;

export interface WorkflowRuntimeHooks {
  beforeWorkflow?: (
    input: BeforeWorkflowInput,
  ) => MaybePromise<BeforeWorkflowPatch | void>;
  beforeStep?: (
    input: BeforeStepInput,
  ) => MaybePromise<BeforeStepPatch | void>;
  afterStep?: (
    input: AfterStepInput,
  ) => MaybePromise<AfterStepPatch | void>;
  afterPromote?: (
    input: AfterPromoteInput,
  ) => MaybePromise<AfterPromotePatch | void>;
  onVerifyFailure?: (
    input: OnVerifyFailureInput,
  ) => MaybePromise<OnVerifyFailurePatch | void>;
  onStepError?: (
    input: OnStepErrorInput,
  ) => MaybePromise<OnStepErrorPatch | void>;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) {
    return value;
  }

  const propertyValues = Array.isArray(value)
    ? value
    : Object.values(value as Record<string, unknown>);
  for (const propertyValue of propertyValues) {
    deepFreeze(propertyValue);
  }

  return Object.freeze(value);
}

export function createImmutableHookSnapshot<T>(value: T): DeepReadonly<T> {
  return deepFreeze(structuredClone(value)) as DeepReadonly<T>;
}

function hasOwn<T extends object>(value: T, key: keyof T): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeString(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function applyStringPatch(
  current: string | null | undefined,
  patch: string | null | undefined,
  shouldApply: boolean,
): string | undefined {
  if (!shouldApply) return normalizeString(current);
  return normalizeString(patch);
}

function mergeUniqueItems<T>(
  current: T[] | undefined,
  patch: T[] | undefined,
  keyFn: (item: T) => string,
): T[] | undefined {
  if (!patch || patch.length === 0) return current;
  const merged = new Map<string, T>();
  for (const item of current ?? []) merged.set(keyFn(item), item);
  for (const item of patch) merged.set(keyFn(item), item);
  return Array.from(merged.values());
}

function mergeOrderedStrings(
  current: string[] | undefined,
  patch: string[] | undefined,
): string[] | undefined {
  if (!patch || patch.length === 0) return current;
  const merged = new Set<string>();
  for (const item of current ?? []) {
    const normalized = normalizeString(item);
    if (normalized) merged.add(normalized);
  }
  for (const item of patch) {
    const normalized = normalizeString(item);
    if (normalized) merged.add(normalized);
  }
  return Array.from(merged.values());
}

function mergeEvidenceHints(
  current: EvidenceHints | undefined,
  patch: EvidenceHints | undefined,
): EvidenceHints | undefined {
  if (!patch) return current;
  const merged: EvidenceHints = {
    touchedFiles: mergeOrderedStrings(current?.touchedFiles, patch.touchedFiles),
    artifactPaths: mergeOrderedStrings(current?.artifactPaths, patch.artifactPaths),
    symbols: mergeOrderedStrings(current?.symbols, patch.symbols),
    commands: mergeOrderedStrings(current?.commands, patch.commands),
  };
  return Object.values(merged).some(Boolean) ? merged : undefined;
}

function decisionKey(item: DecisionItem): string {
  return `${item.topic}\u0000${item.decision}`;
}

function artifactKey(item: ArtifactItem): string {
  return `${item.kind}\u0000${item.path ?? ""}\u0000${item.text ?? ""}`;
}

function blockerKey(item: BlockerItem): string {
  return `${item.issue}\u0000${item.needs ?? ""}`;
}

function verificationKey(item: VerificationItem): string {
  return `${item.check}\u0000${item.status}\u0000${item.notes ?? ""}`;
}

function workItemKey(item: WorkItem): string {
  return item.id || item.title.trim().toLowerCase();
}

function appendItems<T>(current: T[] | undefined, patch: T[] | undefined): T[] | undefined {
  if (!patch || patch.length === 0) return current;
  if (!current || current.length === 0) return [...patch];
  return [...current, ...patch];
}

function mergeSharedPatchIntoContext(
  current: WorkOrder["context"],
  patch: WorkOrderContextPatch | undefined,
): WorkOrder["context"] {
  if (!patch) return current;

  return {
    ...current,
    summary: applyStringPatch(current.summary, patch.summary, hasOwn(patch, "summary")),
    decisions: mergeUniqueItems(current.decisions, patch.decisions, decisionKey),
    artifacts: mergeUniqueItems(current.artifacts, patch.artifacts, artifactKey),
    learnings: mergeOrderedStrings(current.learnings, patch.learnings),
    blockers: mergeUniqueItems(current.blockers, patch.blockers, blockerKey),
    verification: mergeUniqueItems(
      current.verification,
      patch.verification,
      verificationKey,
    ),
    recentResolvedWorkItems: mergeUniqueItems(
      current.recentResolvedWorkItems,
      patch.recentResolvedWorkItems,
      workItemKey,
    ),
  };
}

function mergeStatus(
  current: AgentResult["status"],
  patch: AgentResult["status"] | undefined,
): AgentResult["status"] {
  if (!patch) return current;
  const rank = {
    success: 0,
    blocked: 1,
    failed: 2,
  } as const;
  return rank[patch] > rank[current] ? patch : current;
}

export function mergeSharedStatePatch(
  current: SharedState,
  patch: SharedStatePatch | undefined,
): SharedState {
  if (!patch) return current;

  return {
    ...current,
    summary: applyStringPatch(current.summary, patch.summary, hasOwn(patch, "summary")),
    focus: applyStringPatch(current.focus, patch.focus, hasOwn(patch, "focus")),
    decisions:
      mergeUniqueItems(current.decisions, patch.decisions, decisionKey) ??
      current.decisions,
    artifacts:
      mergeUniqueItems(current.artifacts, patch.artifacts, artifactKey) ??
      current.artifacts,
    learnings:
      mergeOrderedStrings(current.learnings, patch.learnings) ?? current.learnings,
    blockers:
      mergeUniqueItems(current.blockers, patch.blockers, blockerKey) ??
      current.blockers,
    verification:
      mergeUniqueItems(
        current.verification,
        patch.verification,
        verificationKey,
      ) ?? current.verification,
  };
}

export function mergeBeforeStepPatch(
  current: WorkOrder,
  patch: BeforeStepPatch | undefined,
): WorkOrder {
  if (!patch) return current;

  return {
    ...current,
    objective: applyStringPatch(
      current.objective,
      patch.objective,
      hasOwn(patch, "objective"),
    ) ?? current.objective,
    agentDescription: applyStringPatch(
      current.agentDescription,
      patch.agentDescription,
      hasOwn(patch, "agentDescription"),
    ),
    constraints:
      mergeOrderedStrings(current.constraints, patch.constraints) ?? current.constraints,
    profileGuidance:
      mergeOrderedStrings(current.profileGuidance, patch.profileGuidance) ??
      current.profileGuidance,
    allowedTools:
      mergeOrderedStrings(current.allowedTools, patch.allowedTools) ?? current.allowedTools,
    definitionOfDone:
      mergeOrderedStrings(current.definitionOfDone, patch.definitionOfDone) ??
      current.definitionOfDone,
    requiredEvidence:
      mergeOrderedStrings(current.requiredEvidence, patch.requiredEvidence) ??
      current.requiredEvidence,
    expectedOutput:
      mergeUniqueItems(
        current.expectedOutput,
        patch.expectedOutput,
        (item) => item,
      ) ?? current.expectedOutput,
    context: mergeSharedPatchIntoContext(current.context, patch.context),
  };
}

export function mergeAfterStepPatch(
  current: AgentResult,
  patch: AfterStepPatch | undefined,
): AgentResult {
  if (!patch) return current;

  return {
    ...current,
    status: mergeStatus(current.status, patch.status),
    summary:
      applyStringPatch(current.summary, patch.summary, hasOwn(patch, "summary")) ??
      current.summary,
    decisions: mergeUniqueItems(current.decisions, patch.decisions, decisionKey),
    artifacts: mergeUniqueItems(current.artifacts, patch.artifacts, artifactKey),
    learnings: mergeOrderedStrings(current.learnings, patch.learnings),
    blockers: mergeUniqueItems(current.blockers, patch.blockers, blockerKey),
    verification: mergeUniqueItems(
      current.verification,
      patch.verification,
      verificationKey,
    ),
    newWorkItems: appendItems(current.newWorkItems, patch.newWorkItems),
    resolvedWorkItems: appendItems(
      current.resolvedWorkItems,
      patch.resolvedWorkItems,
    ),
    focusSummary: applyStringPatch(
      current.focusSummary,
      patch.focusSummary,
      hasOwn(patch, "focusSummary"),
    ),
    nextStepHint: applyStringPatch(
      current.nextStepHint,
      patch.nextStepHint,
      hasOwn(patch, "nextStepHint"),
    ),
    evidenceHints: mergeEvidenceHints(current.evidenceHints, patch.evidenceHints),
  };
}

export function mergeOnStepErrorPatch(
  current: OnStepErrorPatch | undefined,
  patch: OnStepErrorPatch | undefined,
): OnStepErrorPatch | undefined {
  if (!patch) return current;
  if (!current) return { ...patch };

  return {
    summary: applyStringPatch(
      current.summary,
      patch.summary,
      hasOwn(patch, "summary"),
    ),
    focus: applyStringPatch(current.focus, patch.focus, hasOwn(patch, "focus")),
    blockers: mergeUniqueItems(current.blockers, patch.blockers, blockerKey),
    verification: mergeUniqueItems(
      current.verification,
      patch.verification,
      verificationKey,
    ),
    diagnostics: mergeOrderedStrings(current.diagnostics, patch.diagnostics),
  };
}

export function applyOnStepErrorPatch(
  state: WorkflowState,
  stepIndex: number,
  patch: OnStepErrorPatch | undefined,
): void {
  if (!patch) return;

  state.shared = mergeSharedStatePatch(state.shared, {
    summary: patch.summary,
    focus: patch.focus,
    blockers: patch.blockers,
    verification: patch.verification,
  });

  const step = state.steps[stepIndex];
  if (!step) return;

  step.diagnostics =
    mergeOrderedStrings(step.diagnostics, patch.diagnostics) ?? step.diagnostics;
}
