// src/workflow/approval.ts - Approval gate types for workflows

import type { ResolvedWorkflowStep } from "./types";

export interface WorkflowApprovalRequest {
  workflowId: string;
  workflowName: string;
  stepId: string;
  stepTitle: string;
  stepPrompt: string;
  agentId: string;
  agentName: string;
  skills: string[];
}

export interface WorkflowApprovalResult {
  approved: boolean;
  reason?: string;
}

export type WorkflowApprovalHandler = (
  request: WorkflowApprovalRequest
) => Promise<WorkflowApprovalResult | boolean>;

export function buildApprovalRequest(
  workflowId: string,
  workflowName: string,
  step: ResolvedWorkflowStep
): WorkflowApprovalRequest {
  return {
    workflowId,
    workflowName,
    stepId: step.id,
    stepTitle: step.title,
    stepPrompt: step.prompt,
    agentId: step.agent.id,
    agentName: step.agent.name,
    skills: step.skills ?? [],
  };
}

export function normalizeApprovalResult(
  result: WorkflowApprovalResult | boolean | undefined
): WorkflowApprovalResult {
  if (typeof result === "boolean") {
    return {
      approved: result,
      reason: result ? undefined : "Step approval was rejected",
    };
  }

  return {
    approved: result?.approved ?? false,
    reason: result?.reason,
  };
}
