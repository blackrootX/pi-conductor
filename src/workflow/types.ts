// src/workflow/types.ts - Workflow definition types

import type { AgentSpec } from "../types";

// ============================================================================
// Workflow Definition
// ============================================================================

export interface WorkflowSpec {
  id: string;
  name: string;
  description?: string;
  steps: WorkflowStep[];
  policy?: WorkflowPolicy;
  synthesis?: WorkflowSynthesisConfig;
}

export interface WorkflowPolicy {
  /** Maximum number of steps to run in parallel */
  maxParallelism?: number;
  /** Behavior when a step fails */
  onStepFailure?: StepFailurePolicy;
}

export type StepFailurePolicy = "abort" | "continue";

export interface WorkflowSynthesisConfig {
  /** Synthesis strategy to use */
  strategy?: SynthesisStrategy;
}

export type SynthesisStrategy = "lead" | "all" | "concise";

// ============================================================================
// Workflow Steps
// ============================================================================

export type StepTarget =
  | { agentId: string }
  | { role: string }
  | { capability: string };

export interface WorkflowStep {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
}

export type UnresolvedWorkflowStep = WorkflowStep & StepTarget;

export interface ResolvedWorkflowStep {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
  agent: AgentSpec;
  target: StepTarget;
}

// ============================================================================
// Step Result Model
// ============================================================================

export interface StepResultEnvelope {
  stepId: string;
  stepTitle: string;
  agentId: string;
  agentName: string;
  sessionId: string;
  status: StepStatus;
  summary: string;
  artifact: StepArtifact;
  startedAt: string;
  finishedAt?: string;
  error?: string;
}

export type StepStatus = "pending" | "running" | "completed" | "failed";

export interface StepArtifact {
  type: "text" | "json";
  value: string | unknown;
}

// ============================================================================
// Workflow Run
// ============================================================================

export interface WorkflowRunResult {
  runId: string;
  workflowId: string;
  workflowName: string;
  summary: string;
  finalText: string;
  stepResults: Record<string, StepResultEnvelope>;
  startedAt: string;
  finishedAt?: string;
  status: WorkflowRunStatus;
  error?: string;
}

export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "aborted";

// ============================================================================
// Resolved Workflow
// ============================================================================

export interface ResolvedWorkflow {
  spec: WorkflowSpec;
  steps: ResolvedWorkflowStep[];
  policy: Required<WorkflowPolicy>;
  synthesis: Required<WorkflowSynthesisConfig>;
}
