import {
  getBlockedWorkItems,
  getDoneWorkItems,
  getOpenWorkItems,
  getUnresolvedWorkItems,
} from "./workflow-work-items.js";
import { WORKFLOW_RESULT_BEGIN } from "./workflow-prompts.js";
import { extractStructuredBlock } from "./workflow-result.js";
import type { WorkflowDetails } from "./workflow-runtime.js";

export type WorkflowPresentationStepStatus =
  | "pending"
  | "running"
  | "done"
  | "error";

export interface WorkflowPresentationStep {
  stepNumber: number;
  stepId: string;
  agent: string;
  objective: string;
  model?: string;
  status: WorkflowPresentationStepStatus;
  rawStatus: WorkflowDetails["state"]["steps"][number]["status"];
  elapsedMs: number;
  lastWork: string;
  repairAttempted?: boolean;
  currentFocus?: string;
  topPendingWorkItem?: string;
  parseError?: string;
}

export interface WorkflowPresentationPayload {
  workflowName: string;
  workflowSource: WorkflowDetails["workflowSource"];
  workflowFilePath: WorkflowDetails["workflowFilePath"];
  runId: string;
  userTask: string;
  status: WorkflowDetails["state"]["status"];
  startedAt: string;
  finishedAt?: string;
  currentStepIndex: number;
  currentStepNumber?: number;
  currentStepAgent?: string;
  currentStepObjective?: string;
  currentFocus?: string;
  topPendingWorkItem?: string;
  lastProgress: string;
  summary: {
    openWorkItems: number;
    doneWorkItems: number;
    blockedWorkItems: number;
    blockers: number;
    decisions: number;
    learnings: number;
    verification: number;
  };
  blockers: string[];
  decisions: string[];
  learnings: string[];
  verification: string[];
  openWorkItems: string[];
  doneWorkItems: string[];
  blockedWorkItems: string[];
  steps: WorkflowPresentationStep[];
}

function deriveCurrentFocus(details: WorkflowDetails): string | undefined {
  const explicitFocus = details.state.shared.focus?.trim();
  if (explicitFocus) return explicitFocus;
  return getUnresolvedWorkItems(details.state.shared.workItems)[0]?.title;
}

function formatTopPendingWorkItem(details: WorkflowDetails): string | undefined {
  const item = getUnresolvedWorkItems(details.state.shared.workItems)[0];
  if (!item) return undefined;
  const parts = [item.title, item.status];
  if (item.priority) parts.push(item.priority);
  return parts.join(" | ");
}

function formatWorkItemLine(
  item: WorkflowDetails["state"]["shared"]["workItems"][number],
): string {
  const parts = [item.title, item.status];
  if (item.priority) parts.push(item.priority);
  if (item.details?.trim()) parts.push(item.details.trim());
  return parts.join(" | ");
}

function extractStructuredSummary(text: string): string | undefined {
  const block = extractStructuredBlock(text);
  if (!block) return undefined;

  try {
    const parsed = JSON.parse(block) as { summary?: unknown };
    return typeof parsed.summary === "string" && parsed.summary.trim()
      ? parsed.summary.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

function formatProgressText(text: string | undefined): string {
  const trimmed = text?.trim() ?? "";
  if (!trimmed) return "";

  const summary = extractStructuredSummary(trimmed);
  if (summary) return summary;
  if (trimmed.includes(WORKFLOW_RESULT_BEGIN)) {
    return "Finalizing structured workflow result...";
  }
  return trimmed;
}

export function buildWorkflowPresentation(
  details: WorkflowDetails,
  defaultModel?: string,
): WorkflowPresentationPayload {
  const currentFocus = deriveCurrentFocus(details);
  const topPendingWorkItem = formatTopPendingWorkItem(details);
  const currentStateStep = details.state.steps[details.state.currentStepIndex];

  const steps = details.steps.map((step, index) => {
    const result = details.results.find(
      (item) => item.stepId === step.id || item.step === index + 1,
    );
    const stateStep = details.state.steps[index];
    const stepStatus = stateStep?.status ?? "pending";
    const status: WorkflowPresentationStepStatus =
      stepStatus === "failed" || stepStatus === "blocked"
        ? "error"
        : stepStatus === "running"
          ? "running"
          : stepStatus === "done"
            ? "done"
            : "pending";

    return {
      stepNumber: index + 1,
      stepId: step.id,
      agent: step.agent,
      objective: stateStep?.objective ?? `Run ${step.agent}`,
      model: result?.model ?? defaultModel,
      status,
      rawStatus: stepStatus,
      elapsedMs: result?.elapsedMs ?? 0,
      lastWork: formatProgressText(result?.lastWork ?? stateStep?.result?.summary ?? ""),
      repairAttempted: result?.repairAttempted,
      currentFocus,
      topPendingWorkItem,
      parseError: result?.parseError ?? stateStep?.parseError,
    };
  });

  const currentStepLastWork = steps[details.state.currentStepIndex]?.lastWork;
  const latestResultLastWork = formatProgressText(
    details.results[details.results.length - 1]?.lastWork,
  );
  const lastProgress =
    currentStepLastWork ||
    (currentStateStep?.status === "running" ? "" : latestResultLastWork) ||
    details.state.shared.summary ||
    "";

  return {
    workflowName: details.workflowName,
    workflowSource: details.workflowSource,
    workflowFilePath: details.workflowFilePath,
    runId: details.state.runId,
    userTask: details.state.userTask,
    status: details.state.status,
    startedAt: details.state.startedAt,
    finishedAt: details.state.finishedAt,
    currentStepIndex: details.state.currentStepIndex,
    currentStepNumber: currentStateStep ? details.state.currentStepIndex + 1 : undefined,
    currentStepAgent: currentStateStep?.agent,
    currentStepObjective: currentStateStep?.objective,
    currentFocus,
    topPendingWorkItem,
    lastProgress,
    summary: {
      openWorkItems: getOpenWorkItems(details.state.shared.workItems).length,
      doneWorkItems: getDoneWorkItems(details.state.shared.workItems).length,
      blockedWorkItems: getBlockedWorkItems(details.state.shared.workItems).length,
      blockers: details.state.shared.blockers.length,
      decisions: details.state.shared.decisions.length,
      learnings: details.state.shared.learnings.length,
      verification: details.state.shared.verification.length,
    },
    blockers: details.state.shared.blockers.map((item) =>
      item.needs ? `${item.issue} (needs: ${item.needs})` : item.issue,
    ),
    decisions: details.state.shared.decisions.map((item) =>
      item.rationale
        ? `${item.topic}: ${item.decision} (${item.rationale})`
        : `${item.topic}: ${item.decision}`,
    ),
    learnings: [...details.state.shared.learnings],
    verification: details.state.shared.verification.map((item) =>
      item.notes
        ? `${item.check}: ${item.status} (${item.notes})`
        : `${item.check}: ${item.status}`,
    ),
    openWorkItems: getOpenWorkItems(details.state.shared.workItems).map(
      formatWorkItemLine,
    ),
    doneWorkItems: getDoneWorkItems(details.state.shared.workItems).map(
      formatWorkItemLine,
    ),
    blockedWorkItems: getBlockedWorkItems(details.state.shared.workItems).map(
      formatWorkItemLine,
    ),
    steps,
  };
}
