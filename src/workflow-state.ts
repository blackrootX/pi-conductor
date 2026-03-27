import type { AgentConfig } from "./agents.js";
import type {
  AgentResult,
  ArtifactItem,
  DecisionItem,
  EvidenceHints,
  ExecutionProfile,
  SharedState,
  VerificationItem,
  WorkItem,
  WorkflowCanonicalStepSnapshot,
  WorkflowConfig,
  WorkflowPersistedStateSnapshot,
  WorkflowSource,
  WorkflowState,
  WorkflowStepConfig,
  WorkOrder,
} from "./workflow-types.js";
import {
  createWorkItemId,
  findWorkItemByTitle,
  findWorkItemForBlocker,
  getBlockedWorkItems,
  getDoneWorkItems,
  getOpenWorkItems,
  getRecentResolvedWorkItems,
  getUnresolvedWorkItems,
} from "./workflow-work-items.js";

const MAX_OBJECTIVE_OPEN_ITEMS = 3;
const MAX_PROJECTED_OPEN_ITEMS = 6;
const MAX_PROJECTED_RESOLVED_ITEMS = 4;

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

function normalizeText(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function mergePriority(
  current: WorkItem["priority"],
  incoming: WorkItem["priority"],
): WorkItem["priority"] {
  if (!current) return incoming;
  if (!incoming) return current;

  const rank = { high: 3, medium: 2, low: 1 } as const;
  return rank[incoming] > rank[current] ? incoming : current;
}

function deriveCurrentFocus(state: WorkflowState): string | undefined {
  const explicitFocus = state.shared.focus?.trim();
  if (explicitFocus) return explicitFocus;

  const topOpenWorkItem = getOpenWorkItems(state.shared.workItems)[0];
  if (topOpenWorkItem) return topOpenWorkItem.title;

  const topBlockedWorkItem = getBlockedWorkItems(state.shared.workItems)[0];
  if (topBlockedWorkItem) return `Unblock: ${topBlockedWorkItem.title}`;

  const latestBlocker = state.shared.blockers.at(-1);
  if (latestBlocker?.issue.trim()) return latestBlocker.issue.trim();

  return undefined;
}

export function normalizeDecisions(
  decisions: DecisionItem[] | undefined,
): DecisionItem[] | undefined {
  if (!decisions?.length) return undefined;
  return uniqueBy(
    decisions
      .map((item) => ({
        topic: item.topic.trim(),
        decision: item.decision.trim(),
        rationale: normalizeText(item.rationale),
      }))
      .filter((item) => item.topic && item.decision),
    (item) => `${item.topic}\u0000${item.decision}`,
  );
}

export function normalizeArtifacts(
  artifacts: ArtifactItem[] | undefined,
): ArtifactItem[] | undefined {
  if (!artifacts?.length) return undefined;
  return uniqueBy(
    artifacts
      .map((item) => ({
        kind: item.kind.trim(),
        path: normalizeText(item.path),
        text: normalizeText(item.text),
      }))
      .filter((item) => item.kind),
    (item) => `${item.kind}\u0000${item.path ?? ""}\u0000${item.text ?? ""}`,
  );
}

export function normalizeLearnings(learnings: string[] | undefined): string[] | undefined {
  if (!learnings?.length) return undefined;
  return uniqueBy(
    learnings.map((item) => item.trim()).filter(Boolean),
    (item) => item,
  );
}

export function normalizeBlockers(
  blockers: WorkflowState["shared"]["blockers"] | undefined,
): WorkflowState["shared"]["blockers"] | undefined {
  if (!blockers?.length) return undefined;
  return blockers
    .map((item) => ({
      issue: item.issue.trim(),
      needs: normalizeText(item.needs),
    }))
    .filter((item) => item.issue);
}

export function normalizeVerification(
  verification: VerificationItem[] | undefined,
): VerificationItem[] | undefined {
  if (!verification?.length) return undefined;
  return uniqueBy(
    verification
      .map((item) => ({
        check: item.check.trim(),
        status: item.status,
        notes: normalizeText(item.notes),
        kind: item.kind,
        path: normalizeText(item.path),
        source: item.source,
      }))
      .filter((item) => item.check),
    (item) =>
      `${item.check}\u0000${item.status}\u0000${item.notes ?? ""}\u0000${item.kind ?? ""}\u0000${item.path ?? ""}\u0000${item.source ?? ""}`,
  );
}

export function normalizeEvidenceHints(
  evidenceHints: EvidenceHints | undefined,
): EvidenceHints | undefined {
  if (!evidenceHints) return undefined;
  const normalized: EvidenceHints = {
    touchedFiles: normalizeLearnings(evidenceHints.touchedFiles),
    artifactPaths: normalizeLearnings(evidenceHints.artifactPaths),
    symbols: normalizeLearnings(evidenceHints.symbols),
    commands: normalizeLearnings(evidenceHints.commands),
  };
  return Object.values(normalized).some(Boolean) ? normalized : undefined;
}

function buildPlanningObjective(
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
  state: WorkflowState,
  index: number,
  total: number,
): string {
  const stepLabel = `step ${index + 1} of ${total}`;
  const agentHint = agent?.description?.trim()
    ? `Use the agent specialty as a hint, not as a rigid role: ${agent.description.trim()}.`
    : undefined;
  const currentFocus = deriveCurrentFocus(state);
  const openWorkItems = getOpenWorkItems(state.shared.workItems);
  const topOpenWorkTitles = openWorkItems
    .slice(0, MAX_OBJECTIVE_OPEN_ITEMS)
    .map((item) => item.title);

  return [
    `Advance ${stepLabel} for the "${state.workflowName}" workflow using agent "${step.agent}".`,
    agentHint,
    "This is a planning step: inspect the repository and workflow state, but do not implement the task in this step.",
    topOpenWorkTitles.length > 0
      ? `Prioritize clarifying, refining, or reordering the currently open work items instead of executing them yourself: ${topOpenWorkTitles.join("; ")}.`
      : "Break the user's task into actionable `newWorkItems` for a later implementation step. If the task is already complete, verify that through inspection only.",
    currentFocus
      ? `Keep the current focus in mind: ${currentFocus}.`
      : "Identify the best next focus that will help the next step execute efficiently.",
    "Do not modify files, create files, or claim implementation work you did not perform in this step.",
    "Use the structured result to record decisions, blockers, verification, and a short focusSummary for the next step.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildVerifyContextObjective(
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
  state: WorkflowState,
  index: number,
  total: number,
): string {
  const baseObjective = buildGenericObjective(
    step,
    agent,
    state,
    index,
    total,
    "explore",
  );
  return `${baseObjective} Focus on gathering concrete evidence for later runtime verification instead of self-certifying completion.`;
}

function buildGenericObjective(
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
  state: WorkflowState,
  index: number,
  total: number,
  profile: ExecutionProfile,
): string {
  if (profile === "planning" || step.agent === "plan") {
    return buildPlanningObjective(step, agent, state, index, total);
  }
  if (profile === "verify-context") {
    return buildVerifyContextObjective(step, agent, state, index, total);
  }

  const stepLabel = `step ${index + 1} of ${total}`;
  const agentHint = agent?.description?.trim()
    ? `Use the agent specialty as a hint, not as a rigid role: ${agent.description.trim()}.`
    : undefined;
  const currentFocus = deriveCurrentFocus(state);
  const openWorkItems = getOpenWorkItems(state.shared.workItems);
  const recentResolvedWorkItems = getRecentResolvedWorkItems(state.shared.workItems, 2);
  const hasCompletedSteps = state.steps.slice(0, index).some((item) => item.status === "done");

  if (!hasCompletedSteps && openWorkItems.length === 0) {
    return [
      `Advance ${stepLabel} for the "${state.workflowName}" workflow using agent "${step.agent}".`,
      agentHint,
      profile === "explore"
        ? "Start by understanding the user's task and inspecting the repository or shared state that matters for this read-only step."
        : "Start by understanding the user's task and inspecting the repository or shared state that matters for this step.",
      currentFocus
        ? `Keep the current focus in mind: ${currentFocus}.`
        : "Identify the most important focus that will move the workflow forward.",
      profile === "explore"
        ? "Gather concrete findings, evidence targets, and next-step guidance without modifying repository state."
        : "Make concrete progress, and when relevant return actionable newWorkItems, blockers, and a short focusSummary for the next step.",
    ]
      .filter(Boolean)
      .join(" ");
  }

  const topOpenWorkTitles = openWorkItems
    .slice(0, MAX_OBJECTIVE_OPEN_ITEMS)
    .map((item) => item.title);
  const resolvedHint = recentResolvedWorkItems.length > 0
    ? `Avoid repeating recently resolved work unless you found a regression or a follow-up dependency: ${recentResolvedWorkItems.map((item) => item.title).join("; ")}.`
    : undefined;

  return [
    `Advance ${stepLabel} for the "${state.workflowName}" workflow using agent "${step.agent}".`,
    agentHint,
    topOpenWorkTitles.length > 0
      ? `Prioritize the currently open work items before starting unrelated work: ${topOpenWorkTitles.join("; ")}.`
      : "If no open work items exist yet, identify and complete the next most actionable piece of work.",
    currentFocus ? `Current focus: ${currentFocus}.` : undefined,
    resolvedHint,
    profile === "explore"
      ? "Record findings, blockers, and evidence hints in the structured result so a later step can act on verified context."
      : "Record newly discovered work, resolved work, blockers, and focus updates in the structured result so the next step can continue from shared state.",
  ]
    .filter(Boolean)
    .join(" ");
}

function buildProfileGuidance(profile: ExecutionProfile): string[] {
  switch (profile) {
    case "planning":
      return [
        "Stay in planning mode and keep implementation as future work unless inspection proves it already exists.",
        "Turn ambiguity into actionable next work instead of trying to execute everything inside this step.",
      ];
    case "explore":
      return [
        "Treat this as a read-only investigation step.",
        "Prefer concrete file, symbol, and behavior findings over broad architectural speculation.",
      ];
    case "verify-context":
      return [
        "Gather precise evidence for later runtime verification.",
        "Do not self-certify the outcome; return evidence hints the runtime can inspect.",
      ];
    case "implement":
    default:
      return [
        "Treat this as execution work, not just discussion.",
        "Prefer the smallest concrete repository change that satisfies the objective.",
      ];
  }
}

function buildDefinitionOfDone(profile: ExecutionProfile): string[] {
  switch (profile) {
    case "planning":
      return [
        "The next actionable work is clear, scoped, and captured in the structured result.",
        "The step does not claim file edits or implementation unless inspection confirmed pre-existing work.",
      ];
    case "explore":
      return [
        "The relevant repository context has been inspected and summarized clearly.",
        "The step records concrete findings, blockers, or next actions without modifying files.",
      ];
    case "verify-context":
      return [
        "The step returns concrete evidence hints the runtime can inspect later.",
        "The step avoids claiming final verification ownership.",
      ];
    case "implement":
    default:
      return [
        "The targeted repository work is completed or a concrete blocker is recorded.",
        "The structured result records what changed, what remains, and evidence the runtime can verify.",
      ];
  }
}

function buildRequiredEvidence(profile: ExecutionProfile): string[] {
  switch (profile) {
    case "planning":
      return [
        "List any inspected files or symbols that support the planning conclusions.",
        "If you confirm pre-existing implementation, include the relevant file paths or symbols in evidenceHints.",
      ];
    case "explore":
      return [
        "Return inspected file paths, symbols, or artifacts that support your findings.",
        "Include evidenceHints when a later implementation or verify step should inspect specific targets.",
      ];
    case "verify-context":
      return [
        "Return precise evidenceHints for touched files, artifact paths, symbols, or commands worth checking.",
        "Prefer concrete repository targets over narrative summaries alone.",
      ];
    case "implement":
    default:
      return [
        "Return evidenceHints for touched files and any produced artifact paths.",
        "When relevant, include symbols or commands that help the runtime verify the claimed work.",
      ];
  }
}

export function createInitialSharedState(): SharedState {
  return {
    summary: undefined,
    focus: undefined,
    decisions: [],
    artifacts: [],
    learnings: [],
    blockers: [],
    verification: [],
    workItems: [],
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
      objective: `Prepare ${step.agent} for step ${index + 1} of ${workflow.steps.length}.`,
      status: "pending",
    })),
  };
}

export function buildWorkOrder(
  state: WorkflowState,
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
  index: number,
  profile: ExecutionProfile,
): WorkOrder {
  const objective = buildGenericObjective(
    step,
    agent,
    state,
    index,
    state.steps.length,
    profile,
  );
  const openWorkItems = getUnresolvedWorkItems(state.shared.workItems)
    .slice(0, MAX_PROJECTED_OPEN_ITEMS)
    .map((item) => ({ ...item }));
  const recentResolvedWorkItems = getRecentResolvedWorkItems(
    state.shared.workItems,
    MAX_PROJECTED_RESOLVED_ITEMS,
  ).map((item) => ({ ...item }));
  const currentFocus = deriveCurrentFocus(state);
  const allowedTools =
    agent?.tools && agent.tools.length > 0 ? [...agent.tools] : undefined;
  const profileGuidance = buildProfileGuidance(profile);
  const definitionOfDone = buildDefinitionOfDone(profile);
  const requiredEvidence = buildRequiredEvidence(profile);

  const constraints = [
    "You are reporting to the workflow orchestrator, not speaking directly to the next agent.",
    "Return the required structured result block exactly once.",
    "Do not rely on free-form prose alone for critical workflow state.",
    "The runtime owns final verification after this step completes.",
  ];
  if (profile === "planning" || step.agent === "plan") {
    constraints.push(
      "This is a planning step. Do not modify files, create files, or otherwise change repository state.",
      "Do not use write, edit, or implementation commands to complete the task yourself. Hand execution to a later step via newWorkItems or verified context.",
    );
  } else if (profile === "explore" || profile === "verify-context") {
    constraints.push(
      "Treat this as a read-only step unless the runtime tool policy explicitly allows writes.",
      "Do not describe runtime verification as already complete; return evidence the runtime can inspect later.",
    );
  }

  return {
    stepId: step.id,
    agent: step.agent,
    profile,
    agentDescription: agent?.description?.trim() || undefined,
    objective,
    context: {
      userTask: state.userTask,
      summary: state.shared.summary,
      decisions: state.shared.decisions,
      artifacts: state.shared.artifacts,
      learnings: state.shared.learnings,
      blockers: state.shared.blockers,
      verification: state.shared.verification,
      openWorkItems,
      recentResolvedWorkItems,
      currentFocus,
    },
    constraints,
    profileGuidance,
    allowedTools,
    definitionOfDone,
    requiredEvidence,
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
  step.verifyStatus = "pending";
  step.verifySummary = undefined;
  step.verifyChecks = undefined;
  step.verifyAttemptCount = 0;
  step.result = undefined;
  step.provisionalResult = undefined;
  step.evidenceHints = undefined;
  step.rawFinalText = undefined;
  step.repairedFinalText = undefined;
  step.parseError = undefined;
  step.diagnostics = undefined;
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
  const stepId = step.stepId;
  const agentName = step.agent;
  const touchedWorkProgression =
    Boolean(result.newWorkItems?.length) ||
    Boolean(result.resolvedWorkItems?.length) ||
    Boolean(result.blockers?.length);

  const summary = result.summary.trim();
  if (summary) state.shared.summary = summary;
  if (result.focusSummary?.trim()) {
    state.shared.focus = result.focusSummary.trim();
  } else if (touchedWorkProgression) {
    state.shared.focus = undefined;
  }

  const normalizedDecisions = normalizeDecisions(result.decisions);
  const normalizedArtifacts = normalizeArtifacts(result.artifacts);
  const normalizedLearnings = normalizeLearnings(result.learnings);
  const normalizedBlockers = normalizeBlockers(result.blockers);
  const normalizedVerification = normalizeVerification(result.verification);
  const normalizedEvidenceHints = normalizeEvidenceHints(result.evidenceHints);

  if (normalizedDecisions?.length) {
    state.shared.decisions = uniqueBy(
      [...state.shared.decisions, ...normalizedDecisions],
      (item: DecisionItem) => `${item.topic}\u0000${item.decision}`,
    );
  }

  if (normalizedArtifacts?.length) {
    state.shared.artifacts = uniqueBy(
      [...state.shared.artifacts, ...normalizedArtifacts],
      (item: ArtifactItem) => `${item.kind}\u0000${item.path ?? ""}\u0000${item.text ?? ""}`,
    );
  }

  if (normalizedLearnings?.length) {
    state.shared.learnings = uniqueBy(
      [...state.shared.learnings, ...normalizedLearnings],
      (item) => item,
    );
  }

  if (normalizedBlockers?.length) {
    state.shared.blockers = [...state.shared.blockers, ...normalizedBlockers];
  }

  if (normalizedVerification?.length) {
    state.shared.verification = [
      ...state.shared.verification,
      ...normalizedVerification,
    ];
  }

  if (result.newWorkItems?.length) {
    for (const newWorkItem of result.newWorkItems) {
      const existing = findWorkItemByTitle(state.shared.workItems, newWorkItem.title);
      if (existing) {
        existing.title = newWorkItem.title;
        existing.details = newWorkItem.details ?? existing.details;
        existing.priority = mergePriority(existing.priority, newWorkItem.priority);
        existing.status =
          existing.status === "done"
            ? "open"
            : existing.status === "in_progress"
              ? "in_progress"
              : existing.status === "blocked"
                ? "blocked"
                : "open";
        existing.updatedAt = finishedAt;
        continue;
      }

      state.shared.workItems.push({
        id: createWorkItemId(newWorkItem.title),
        title: newWorkItem.title,
        details: newWorkItem.details,
        status: "open",
        priority: newWorkItem.priority,
        sourceStepId: stepId,
        sourceAgent: agentName,
        updatedAt: finishedAt,
      });
    }
  }

  if (result.resolvedWorkItems?.length) {
    for (const resolvedWorkItem of result.resolvedWorkItems) {
      const existing = findWorkItemByTitle(state.shared.workItems, resolvedWorkItem.title);
      if (existing) {
        existing.title = resolvedWorkItem.title;
        existing.status = "done";
        existing.updatedAt = finishedAt;
        continue;
      }

      state.shared.workItems.push({
        id: createWorkItemId(resolvedWorkItem.title),
        title: resolvedWorkItem.title,
        status: "done",
        sourceStepId: stepId,
        sourceAgent: agentName,
        updatedAt: finishedAt,
      });
    }
  }

  if (normalizedBlockers?.length) {
    for (const blocker of normalizedBlockers) {
      const matchingWorkItem = findWorkItemForBlocker(state.shared.workItems, blocker.issue);
      if (!matchingWorkItem || matchingWorkItem.status === "done") continue;
      matchingWorkItem.status = "blocked";
      matchingWorkItem.updatedAt = finishedAt;
    }
  }

  step.result = {
    ...result,
    decisions: normalizedDecisions,
    artifacts: normalizedArtifacts,
    learnings: normalizedLearnings,
    blockers: normalizedBlockers,
    verification: normalizedVerification,
    evidenceHints: normalizedEvidenceHints,
  };
  step.provisionalResult = step.provisionalResult ?? step.result;
  step.evidenceHints = normalizedEvidenceHints;
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

export function deriveProvisionalResult(result: AgentResult): AgentResult {
  return {
    ...result,
    summary: result.summary.trim(),
    decisions: normalizeDecisions(result.decisions),
    artifacts: normalizeArtifacts(result.artifacts),
    learnings: normalizeLearnings(result.learnings),
    blockers: normalizeBlockers(result.blockers),
    verification: normalizeVerification(result.verification),
    evidenceHints: normalizeEvidenceHints(result.evidenceHints),
    focusSummary: normalizeText(result.focusSummary),
    nextStepHint: normalizeText(result.nextStepHint),
  };
}

export function setProvisionalStepResult(
  state: WorkflowState,
  stepIndex: number,
  result: AgentResult,
  rawFinalText: string,
  repairedFinalText?: string,
  parseError?: string,
): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.provisionalResult = deriveProvisionalResult(result);
  step.evidenceHints = normalizeEvidenceHints(result.evidenceHints);
  step.rawFinalText = rawFinalText;
  step.repairedFinalText = repairedFinalText;
  step.parseError = parseError;
}

export function recordVerificationOutcome(
  state: WorkflowState,
  stepIndex: number,
  verifyStatus: NonNullable<WorkflowState["steps"][number]["verifyStatus"]>,
  verifyChecks: VerificationItem[] | undefined,
  verifySummary: string | undefined,
  verifyAttemptCount: number,
): void {
  const step = state.steps[stepIndex];
  if (!step) return;
  step.verifyStatus = verifyStatus;
  step.verifyChecks = normalizeVerification(verifyChecks);
  step.verifySummary = normalizeText(verifySummary);
  step.verifyAttemptCount = verifyAttemptCount;
}

export function buildCanonicalStepSnapshot(
  step: WorkflowState["steps"][number],
): WorkflowCanonicalStepSnapshot {
  return {
    stepId: step.stepId,
    agent: step.agent,
    profile: step.profile,
    objective: step.objective,
    status: step.status,
    verifyStatus: step.verifyStatus,
    verifySummary: step.verifySummary,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
    summary: step.result?.summary,
  };
}

export function buildPersistedWorkflowStateSnapshot(
  state: WorkflowState,
  workflowSource: WorkflowSource,
  workflowFilePath?: string | null,
): WorkflowPersistedStateSnapshot {
  return {
    runId: state.runId,
    workflowName: state.workflowName,
    workflowSource,
    workflowFilePath: workflowFilePath ?? null,
    userTask: state.userTask,
    status: state.status,
    currentStepIndex: state.currentStepIndex,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    shared: {
      ...state.shared,
      decisions: normalizeDecisions(state.shared.decisions) ?? [],
      artifacts: normalizeArtifacts(state.shared.artifacts) ?? [],
      learnings: normalizeLearnings(state.shared.learnings) ?? [],
      blockers: normalizeBlockers(state.shared.blockers) ?? [],
      verification: normalizeVerification(state.shared.verification) ?? [],
    },
    steps: state.steps.map(buildCanonicalStepSnapshot),
  };
}

function formatVerificationLine(item: VerificationItem): string {
  return `- ${item.check}: ${item.status}${item.notes ? ` (${item.notes})` : ""}`;
}

export function buildFinalTextFromState(state: WorkflowState): string {
  const sections: string[] = [];
  const summary = state.shared.summary?.trim();
  if (summary) sections.push(summary);

  const focus = deriveCurrentFocus(state);
  if (focus) {
    sections.push(`Current focus: ${focus}`);
  }

  const unresolvedWorkItems = getUnresolvedWorkItems(state.shared.workItems);
  if (unresolvedWorkItems.length > 0) {
    sections.push(
      [
        "Unresolved work:",
        ...unresolvedWorkItems.map((item) =>
          `- ${item.title} [${item.status}]${item.details ? ` (${item.details})` : ""}`,
        ),
      ].join("\n"),
    );
  }

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
    openWorkItems: getOpenWorkItems(state.shared.workItems).length,
    doneWorkItems: getDoneWorkItems(state.shared.workItems).length,
    blockedWorkItems: getBlockedWorkItems(state.shared.workItems).length,
  };
}
