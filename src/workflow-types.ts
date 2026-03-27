export const WORKFLOW_CHANNELS = [
  "summary",
  "decisions",
  "artifacts",
  "learnings",
  "blockers",
  "verification",
] as const;

export type WorkflowChannel = (typeof WORKFLOW_CHANNELS)[number];

export type WorkflowSource = "built-in" | "global" | "project";
export type ExecutionProfile =
  | "planning"
  | "explore"
  | "implement"
  | "verify-context";
export type VerifyStatus = "pending" | "passed" | "failed" | "skipped";

export interface WorkflowStepConfig {
  id: string;
  agent: string;
}

export interface WorkflowConfig {
  name: string;
  steps: WorkflowStepConfig[];
  source: WorkflowSource;
  filePath?: string;
}

export interface DecisionItem {
  topic: string;
  decision: string;
  rationale?: string;
}

export interface ArtifactItem {
  kind: string;
  path?: string;
  text?: string;
}

export interface BlockerItem {
  issue: string;
  needs?: string;
}

export interface VerificationItem {
  check: string;
  status: "pass" | "fail" | "not_run";
  notes?: string;
  kind?: "file_exists" | "grep_assertion" | "diagnostic" | "claimed";
  path?: string;
  source?: "worker" | "runtime";
}

export interface WorkItem {
  id: string;
  title: string;
  details?: string;
  status: "open" | "in_progress" | "done" | "blocked";
  priority?: "low" | "medium" | "high";
  sourceStepId: string;
  sourceAgent: string;
  updatedAt: string;
}

export interface NewWorkItemInput {
  title: string;
  details?: string;
  priority?: "low" | "medium" | "high";
}

export interface ResolvedWorkItemInput {
  title: string;
  resolution?: string;
}

export interface EvidenceHints {
  touchedFiles?: string[];
  artifactPaths?: string[];
  symbols?: string[];
  commands?: string[];
}

export interface AgentResult {
  status: "success" | "blocked" | "failed";
  summary: string;
  decisions?: DecisionItem[];
  artifacts?: ArtifactItem[];
  learnings?: string[];
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
  newWorkItems?: NewWorkItemInput[];
  resolvedWorkItems?: ResolvedWorkItemInput[];
  focusSummary?: string;
  nextStepHint?: string;
  evidenceHints?: EvidenceHints;
  rawText?: string;
}

export interface SharedState {
  summary?: string;
  focus?: string;
  decisions: DecisionItem[];
  artifacts: ArtifactItem[];
  learnings: string[];
  blockers: BlockerItem[];
  verification: VerificationItem[];
  workItems: WorkItem[];
}

export interface StepRunState {
  stepId: string;
  agent: string;
  profile?: ExecutionProfile;
  objective: string;
  status: "pending" | "running" | "done" | "blocked" | "failed";
  verifyStatus?: VerifyStatus;
  verifySummary?: string;
  verifyChecks?: VerificationItem[];
  verifyAttemptCount?: number;
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
  provisionalResult?: AgentResult;
  evidenceHints?: EvidenceHints;
  rawFinalText?: string;
  repairedFinalText?: string;
  parseError?: string;
  diagnostics?: string[];
}

export interface WorkflowState {
  runId: string;
  workflowName: string;
  userTask: string;
  status: "pending" | "running" | "done" | "blocked" | "failed";
  currentStepIndex: number;
  startedAt: string;
  finishedAt?: string;
  shared: SharedState;
  steps: StepRunState[];
}

export interface WorkflowCanonicalStepSnapshot {
  stepId: string;
  agent: string;
  profile?: ExecutionProfile;
  objective: string;
  status: StepRunState["status"];
  verifyStatus?: VerifyStatus;
  verifySummary?: string;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
}

export interface WorkflowPersistedStateSnapshot {
  runId: string;
  workflowName: string;
  workflowSource: WorkflowSource;
  workflowFilePath?: string | null;
  userTask: string;
  status: WorkflowState["status"];
  currentStepIndex: number;
  startedAt: string;
  finishedAt?: string;
  shared: SharedState;
  steps: WorkflowCanonicalStepSnapshot[];
}

export interface WorkOrder {
  stepId: string;
  agent: string;
  profile?: ExecutionProfile;
  agentDescription?: string;
  objective: string;
  context: {
    userTask: string;
    summary?: string;
    decisions?: DecisionItem[];
    artifacts?: ArtifactItem[];
    learnings?: string[];
    blockers?: BlockerItem[];
    verification?: VerificationItem[];
    openWorkItems?: WorkItem[];
    recentResolvedWorkItems?: WorkItem[];
    currentFocus?: string;
  };
  constraints: string[];
  profileGuidance?: string[];
  allowedTools?: string[];
  definitionOfDone?: string[];
  requiredEvidence?: string[];
  expectedOutput: WorkflowChannel[];
}
