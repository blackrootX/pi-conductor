import type { AgentConfig } from "./agents.js";
import type {
  AgentResult,
  ArtifactItem,
  DecisionItem,
  SharedState,
  VerificationItem,
  WorkItem,
  WorkflowConfig,
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

function buildGenericObjective(
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
  const recentResolvedWorkItems = getRecentResolvedWorkItems(state.shared.workItems, 2);
  const hasCompletedSteps = state.steps.slice(0, index).some((item) => item.status === "done");

  if (!hasCompletedSteps && openWorkItems.length === 0) {
    return [
      `Advance ${stepLabel} for the "${state.workflowName}" workflow using agent "${step.agent}".`,
      agentHint,
      "Start by understanding the user's task and inspecting the repository or shared state that matters for this step.",
      currentFocus
        ? `Keep the current focus in mind: ${currentFocus}.`
        : "Identify the most important focus that will move the workflow forward.",
      "Make concrete progress, and when relevant return actionable newWorkItems, blockers, and a short focusSummary for the next step.",
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
    "Record newly discovered work, resolved work, blockers, and focus updates in the structured result so the next step can continue from shared state.",
  ]
    .filter(Boolean)
    .join(" ");
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
): WorkOrder {
  const objective = buildGenericObjective(step, agent, state, index, state.steps.length);
  const openWorkItems = getUnresolvedWorkItems(state.shared.workItems)
    .slice(0, MAX_PROJECTED_OPEN_ITEMS)
    .map((item) => ({ ...item }));
  const recentResolvedWorkItems = getRecentResolvedWorkItems(
    state.shared.workItems,
    MAX_PROJECTED_RESOLVED_ITEMS,
  ).map((item) => ({ ...item }));
  const currentFocus = deriveCurrentFocus(state);

  return {
    stepId: step.id,
    agent: step.agent,
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

  if (result.blockers?.length) {
    for (const blocker of result.blockers) {
      const matchingWorkItem = findWorkItemForBlocker(state.shared.workItems, blocker.issue);
      if (!matchingWorkItem || matchingWorkItem.status === "done") continue;
      matchingWorkItem.status = "blocked";
      matchingWorkItem.updatedAt = finishedAt;
    }
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
