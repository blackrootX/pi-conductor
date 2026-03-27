import type {
  AgentResult,
  ArtifactItem,
  DecisionItem,
  SharedState,
  VerificationItem,
  WorkflowConfig,
  WorkflowState,
  WorkflowStepConfig,
  WorkOrder,
} from "./workflow-types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function uniqueBy<T>(items: T[], keyFn: (item: T) => string): T[] {
  const seen = new Set<string>();
  const output: T[] = [];
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function defaultObjectiveForStep(
  step: WorkflowStepConfig,
  index: number,
  total: number,
): string {
  if (step.agent === "plan") {
    return `Inspect the repository and produce implementation-ready guidance for step ${index + 1} of ${total}.`;
  }
  if (step.agent === "build") {
    return `Execute the implementation work for step ${index + 1} of ${total} and report the concrete outcome.`;
  }
  return `Execute the "${step.agent}" workflow step and report the most important result for the workflow.`;
}

export function createInitialSharedState(): SharedState {
  return {
    summary: undefined,
    decisions: [],
    artifacts: [],
    learnings: [],
    blockers: [],
    verification: [],
  };
}

export function createWorkflowState(
  workflow: WorkflowConfig,
  userTask: string,
  runId: string,
): WorkflowState {
  return {
    runId,
    workflowName: workflow.name,
    userTask,
    status: "pending",
    currentStepIndex: 0,
    startedAt: nowIso(),
    shared: createInitialSharedState(),
    steps: workflow.steps.map((step, index) => ({
      stepId: step.id,
      agent: step.agent,
      objective: defaultObjectiveForStep(step, index, workflow.steps.length),
      status: "pending",
    })),
  };
}

export function buildWorkOrder(
  state: WorkflowState,
  step: WorkflowStepConfig,
  index: number,
): WorkOrder {
  const objective = state.steps[index]?.objective
    ?? defaultObjectiveForStep(step, index, state.steps.length);

  return {
    stepId: step.id,
    agent: step.agent,
    objective,
    context: {
      userTask: state.userTask,
      summary: state.shared.summary,
      decisions: state.shared.decisions,
      artifacts: state.shared.artifacts,
      learnings: state.shared.learnings,
      blockers: state.shared.blockers,
      verification: state.shared.verification,
    },
    constraints: [
      "You are reporting to the workflow orchestrator, not speaking directly to the next agent.",
      "Return the required structured result block exactly once.",
      "Do not rely on free-form prose alone for critical workflow state.",
    ],
    expectedOutput: [
      "summary",
      "decisions",
      "artifacts",
      "learnings",
      "blockers",
      "verification",
    ],
  };
}

export function markStepRunning(state: WorkflowState, stepIndex: number): void {
  state.status = "running";
  state.currentStepIndex = stepIndex;
  const step = state.steps[stepIndex];
  if (!step) return;
  step.status = "running";
  step.startedAt = step.startedAt ?? nowIso();
}

export function markStepFailure(
  state: WorkflowState,
  stepIndex: number,
  status: "blocked" | "failed",
): void {
  const finishedAt = nowIso();
  state.status = status;
  state.finishedAt = finishedAt;
  const step = state.steps[stepIndex];
  if (!step) return;
  step.status = status;
  step.finishedAt = finishedAt;
}

export function mergeAgentResultIntoState(
  state: WorkflowState,
  stepIndex: number,
  result: AgentResult,
  rawFinalText: string,
  repairedFinalText?: string,
  parseError?: string,
): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  const finishedAt = nowIso();

  const summary = result.summary.trim();
  if (summary) state.shared.summary = summary;

  if (result.decisions?.length) {
    state.shared.decisions = uniqueBy(
      [...state.shared.decisions, ...result.decisions],
      (item: DecisionItem) => `${item.topic}\u0000${item.decision}`,
    );
  }

  if (result.artifacts?.length) {
    state.shared.artifacts = uniqueBy(
      [...state.shared.artifacts, ...result.artifacts],
      (item: ArtifactItem) => `${item.kind}\u0000${item.path ?? ""}\u0000${item.text ?? ""}`,
    );
  }

  if (result.learnings?.length) {
    state.shared.learnings = uniqueBy(
      [...state.shared.learnings, ...result.learnings],
      (item) => item,
    );
  }

  if (result.blockers?.length) {
    state.shared.blockers = [...state.shared.blockers, ...result.blockers];
  }

  if (result.verification?.length) {
    state.shared.verification = [
      ...state.shared.verification,
      ...result.verification,
    ];
  }

  step.result = result;
  step.rawFinalText = rawFinalText;
  step.repairedFinalText = repairedFinalText;
  step.parseError = parseError;
  step.status =
    result.status === "blocked"
      ? "blocked"
      : result.status === "failed"
        ? "failed"
        : "done";
  step.finishedAt = finishedAt;

  if (result.status === "blocked" || result.status === "failed") {
    state.status = result.status;
    state.finishedAt = finishedAt;
  }
}

function formatVerificationLine(item: VerificationItem): string {
  return `- ${item.check}: ${item.status}${item.notes ? ` (${item.notes})` : ""}`;
}

export function buildFinalTextFromState(state: WorkflowState): string {
  const sections: string[] = [];
  const summary = state.shared.summary?.trim();
  if (summary) sections.push(summary);

  if (state.shared.blockers.length > 0) {
    sections.push(
      [
        "Blockers:",
        ...state.shared.blockers.map((item) =>
          `- ${item.issue}${item.needs ? ` (needs: ${item.needs})` : ""}`,
        ),
      ].join("\n"),
    );
  }

  if (state.shared.verification.length > 0) {
    sections.push(
      [
        "Verification:",
        ...state.shared.verification.map(formatVerificationLine),
      ].join("\n"),
    );
  }

  return sections.join("\n\n").trim() || "(no output)";
}

export function completeWorkflowState(state: WorkflowState): void {
  if (state.status === "pending" || state.status === "running") {
    state.status = "done";
  }
  state.finishedAt = nowIso();
}

export function getStateSummaryCounts(state: WorkflowState) {
  return {
    decisions: state.shared.decisions.length,
    learnings: state.shared.learnings.length,
    blockers: state.shared.blockers.length,
    verification: state.shared.verification.length,
  };
}
