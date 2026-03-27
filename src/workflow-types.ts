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
  objective: string;
  status: "pending" | "running" | "done" | "blocked" | "failed";
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
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

export interface WorkOrder {
  stepId: string;
  agent: string;
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
  expectedOutput: WorkflowChannel[];
}
