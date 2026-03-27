import type {
  ExtensionAPI,
  SessionEntry,
} from "@mariozechner/pi-coding-agent";
import type { WorkflowConfig } from "./workflows.js";
import type { WorkflowDetails, WorkflowRunResult } from "./workflow-runtime.js";
import { createWorkflowState } from "./workflow-state.js";
import {
  buildWorkflowPresentation,
  type WorkflowPresentationPayload,
} from "./workflow-presentation.js";

export const WORKFLOW_RUN_STARTED_ENTRY = "workflow-run-started";
export const WORKFLOW_STEP_UPDATED_ENTRY = "workflow-step-updated";
export const WORKFLOW_STEP_FINISHED_ENTRY = "workflow-step-finished";
export const WORKFLOW_RUN_FINISHED_ENTRY = "workflow-run-finished";
export const WORKFLOW_LAST_SELECTION_ENTRY = "workflow-last-selection";
export const WORKFLOW_MESSAGE_TYPE = "workflow-update";

export type WorkflowSessionEventType =
  | "run-started"
  | "step-updated"
  | "step-finished"
  | "run-finished";

export interface WorkflowSelectionRecord {
  workflowName: string;
  task: string;
  cwd: string;
  selectedAt: string;
}

export interface WorkflowSessionSnapshot {
  runId: string;
  workflowName: string;
  workflowSource: WorkflowDetails["workflowSource"];
  workflowFilePath: WorkflowDetails["workflowFilePath"];
  userTask: string;
  status: WorkflowDetails["state"]["status"];
  currentStepIndex: number;
  currentStepId?: string;
  currentStepAgent?: string;
  currentStepObjective?: string;
  startedAt: string;
  finishedAt?: string;
  updatedAt: string;
  finalText?: string;
  errorMessage?: string;
  isError?: boolean;
  presentation: WorkflowPresentationPayload;
}

export interface WorkflowSessionEntryData {
  event: WorkflowSessionEventType;
  snapshot: WorkflowSessionSnapshot;
}

export interface WorkflowMessageDetails {
  event: WorkflowSessionEventType;
  snapshot: WorkflowSessionSnapshot;
}

interface SessionEntryReader {
  getBranch(fromId?: string): SessionEntry[];
}

function nowIso(): string {
  return new Date().toISOString();
}

export function createWorkflowSessionSnapshot(
  details: WorkflowDetails,
  defaultModel?: string,
  extra?: {
    finalText?: string;
    errorMessage?: string;
    isError?: boolean;
    updatedAt?: string;
  },
): WorkflowSessionSnapshot {
  const currentStep = details.state.steps[details.state.currentStepIndex];
  return {
    runId: details.state.runId,
    workflowName: details.workflowName,
    workflowSource: details.workflowSource,
    workflowFilePath: details.workflowFilePath,
    userTask: details.state.userTask,
    status: details.state.status,
    currentStepIndex: details.state.currentStepIndex,
    currentStepId: currentStep?.stepId,
    currentStepAgent: currentStep?.agent,
    currentStepObjective: currentStep?.objective,
    startedAt: details.state.startedAt,
    finishedAt: details.state.finishedAt,
    updatedAt: extra?.updatedAt ?? nowIso(),
    finalText: extra?.finalText,
    errorMessage: extra?.errorMessage,
    isError: extra?.isError,
    presentation: buildWorkflowPresentation(details, defaultModel),
  };
}

export function createInitialWorkflowDetails(
  workflow: WorkflowConfig,
  task: string,
  runId: string,
): WorkflowDetails {
  return {
    workflowName: workflow.name,
    steps: workflow.steps,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    runDir: "",
    results: [],
    state: createWorkflowState(workflow, task, runId),
  };
}

export function appendWorkflowSelection(
  pi: ExtensionAPI,
  record: WorkflowSelectionRecord,
): void {
  pi.appendEntry(WORKFLOW_LAST_SELECTION_ENTRY, record);
}

export function appendWorkflowRunStarted(
  pi: ExtensionAPI,
  details: WorkflowDetails,
  defaultModel?: string,
): WorkflowSessionSnapshot {
  const snapshot = createWorkflowSessionSnapshot(details, defaultModel);
  pi.appendEntry<WorkflowSessionEntryData>(WORKFLOW_RUN_STARTED_ENTRY, {
    event: "run-started",
    snapshot,
  });
  return snapshot;
}

export function appendWorkflowStepUpdated(
  pi: ExtensionAPI,
  details: WorkflowDetails,
  defaultModel?: string,
): WorkflowSessionSnapshot {
  const snapshot = createWorkflowSessionSnapshot(details, defaultModel);
  pi.appendEntry<WorkflowSessionEntryData>(WORKFLOW_STEP_UPDATED_ENTRY, {
    event: "step-updated",
    snapshot,
  });
  return snapshot;
}

export function appendWorkflowStepFinished(
  pi: ExtensionAPI,
  details: WorkflowDetails,
  defaultModel?: string,
): WorkflowSessionSnapshot {
  const snapshot = createWorkflowSessionSnapshot(details, defaultModel);
  pi.appendEntry<WorkflowSessionEntryData>(WORKFLOW_STEP_FINISHED_ENTRY, {
    event: "step-finished",
    snapshot,
  });
  return snapshot;
}

export function appendWorkflowRunFinished(
  pi: ExtensionAPI,
  details: WorkflowDetails,
  result: Pick<WorkflowRunResult, "finalText" | "errorMessage" | "isError">,
  defaultModel?: string,
): WorkflowSessionSnapshot {
  const snapshot = createWorkflowSessionSnapshot(details, defaultModel, {
    finalText: result.finalText,
    errorMessage: result.errorMessage,
    isError: result.isError,
  });
  pi.appendEntry<WorkflowSessionEntryData>(WORKFLOW_RUN_FINISHED_ENTRY, {
    event: "run-finished",
    snapshot,
  });
  return snapshot;
}

export function createWorkflowMessageDetails(
  event: WorkflowSessionEventType,
  snapshot: WorkflowSessionSnapshot,
): WorkflowMessageDetails {
  return { event, snapshot };
}

export function buildWorkflowMessageContent(
  details: WorkflowMessageDetails,
): string {
  const snapshot = details.snapshot;
  const stepLabel =
    snapshot.presentation.currentStepNumber && snapshot.presentation.currentStepAgent
      ? `Step ${snapshot.presentation.currentStepNumber}: ${snapshot.presentation.currentStepAgent}`
      : "Workflow update";
  const status = snapshot.presentation.status;
  const progress = snapshot.presentation.lastProgress.trim();
  return progress
    ? `${stepLabel} (${status})\n${progress}`
    : `${stepLabel} (${status})`;
}

function isWorkflowEntry(
  entry: SessionEntry,
): entry is SessionEntry & {
  type: "custom";
  data?: WorkflowSessionEntryData;
} {
  return (
    entry.type === "custom" &&
    (entry.customType === WORKFLOW_RUN_STARTED_ENTRY ||
      entry.customType === WORKFLOW_STEP_UPDATED_ENTRY ||
      entry.customType === WORKFLOW_STEP_FINISHED_ENTRY ||
      entry.customType === WORKFLOW_RUN_FINISHED_ENTRY)
  );
}

function isWorkflowSelectionEntry(
  entry: SessionEntry,
): entry is SessionEntry & {
  type: "custom";
  data?: WorkflowSelectionRecord;
} {
  return entry.type === "custom" && entry.customType === WORKFLOW_LAST_SELECTION_ENTRY;
}

export function getLatestWorkflowSnapshot(
  sessionManager: SessionEntryReader,
): WorkflowSessionSnapshot | undefined {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!isWorkflowEntry(entry)) continue;
    const snapshot = entry.data?.snapshot;
    if (snapshot) return snapshot;
  }
  return undefined;
}

export function getLatestWorkflowSelection(
  sessionManager: SessionEntryReader,
): WorkflowSelectionRecord | undefined {
  const branch = sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index--) {
    const entry = branch[index];
    if (!isWorkflowSelectionEntry(entry) || !entry.data) continue;
    return entry.data;
  }
  return undefined;
}
