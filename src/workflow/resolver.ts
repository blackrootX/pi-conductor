// src/workflow/resolver.ts - Resolve workflow steps to agents

import type {
  WorkflowSpec,
  ResolvedWorkflow,
  ResolvedWorkflowStep,
  StepTarget,
  UnresolvedWorkflowStep,
} from "./types";
import type { ResolutionResult, AgentSpec } from "../types";
import type { AgentRegistry } from "../registry";

export interface ResolutionError {
  stepId: string;
  target: StepTarget;
  reason: string;
}

export interface ResolveResult {
  success: boolean;
  resolved?: ResolvedWorkflow;
  errors: ResolutionError[];
}

/**
 * Resolve a workflow spec to a resolved workflow with actual agents.
 */
export async function resolveWorkflow(
  spec: WorkflowSpec,
  registry: AgentRegistry
): Promise<ResolveResult> {
  const errors: ResolutionError[] = [];
  const resolvedSteps: ResolvedWorkflowStep[] = [];

  // Validate workflow structure
  const validationErrors = validateWorkflowStructure(spec);
  if (validationErrors.length > 0) {
    return {
      success: false,
      errors: validationErrors,
    };
  }

  // Resolve each step
  for (const step of spec.steps) {
    const unresolvedStep = step as UnresolvedWorkflowStep;
    const target = extractTarget(unresolvedStep);

    if (!target) {
      errors.push({
        stepId: step.id,
        target: { agentId: step.id }, // fallback
        reason: "Step has no target (agentId, role, or capability)",
      });
      continue;
    }

    const agentResult = await resolveTarget(target, registry);

    if (!agentResult.success) {
      errors.push({
        stepId: step.id,
        target,
        reason: agentResult.error?.message || "Failed to resolve agent",
      });
      continue;
    }

    resolvedSteps.push({
      id: step.id,
      title: step.title,
      prompt: step.prompt,
      dependsOn: step.dependsOn,
      agent: agentResult.agent!,
      target,
    });
  }

  // If any errors, return failure
  if (errors.length > 0) {
    return {
      success: false,
      errors,
    };
  }

  // Build resolved workflow with defaults
  const resolved: ResolvedWorkflow = {
    spec,
    steps: resolvedSteps,
    policy: {
      maxParallelism: spec.policy?.maxParallelism ?? 1,
      onStepFailure: spec.policy?.onStepFailure ?? "abort",
    },
    synthesis: {
      strategy: spec.synthesis?.strategy ?? "lead",
    },
  };

  return {
    success: true,
    resolved,
    errors: [],
  };
}

/**
 * Resolve a target to an actual agent.
 */
async function resolveTarget(
  target: StepTarget,
  registry: AgentRegistry,
  allowAmbiguous = false
): Promise<ResolutionResult> {
  if ("agentId" in target) {
    const agent = await registry.findById(target.agentId);
    if (!agent) {
      return {
        success: false,
        error: {
          code: "AGENT_NOT_FOUND",
          message: `Agent not found: ${target.agentId}`,
          requested: { id: target.agentId },
        },
      };
    }
    return {
      success: true,
      agent,
      resolvedBy: "id",
    };
  }

  if ("role" in target) {
    return await registry.resolveByRole(target.role, { allowAmbiguous });
  }

  if ("capability" in target) {
    return await registry.resolveByCapability(target.capability, { allowAmbiguous });
  }

  return {
    success: false,
    error: {
      code: "INVALID_QUERY",
      message: "Unknown target type",
      requested: {},
    },
  };
}

/**
 * Extract target from a step.
 */
function extractTarget(step: UnresolvedWorkflowStep): StepTarget | undefined {
  if ("agentId" in step) return step as { agentId: string };
  if ("role" in step) return step as { role: string };
  if ("capability" in step) return step as { capability: string };
  return undefined;
}

/**
 * Validate workflow structure.
 */
function validateWorkflowStructure(
  spec: WorkflowSpec
): ResolutionError[] {
  const errors: ResolutionError[] = [];
  const stepIds = new Set<string>();

  // Check required fields
  if (!spec.id) {
    errors.push({
      stepId: "",
      target: { agentId: "" },
      reason: "Workflow must have an id",
    });
  }

  if (!spec.name) {
    errors.push({
      stepId: "",
      target: { agentId: "" },
      reason: "Workflow must have a name",
    });
  }

  if (!spec.steps || spec.steps.length === 0) {
    errors.push({
      stepId: "",
      target: { agentId: "" },
      reason: "Workflow must have at least one step",
    });
  }

  // Validate each step
  for (const step of spec.steps || []) {
    if (!step.id) {
      errors.push({
        stepId: "",
        target: { agentId: "" },
        reason: "Step must have an id",
      });
      continue;
    }

    if (stepIds.has(step.id)) {
      errors.push({
        stepId: step.id,
        target: { agentId: step.id },
        reason: "Duplicate step id",
      });
    }
    stepIds.add(step.id);

    if (!step.title) {
      errors.push({
        stepId: step.id,
        target: { agentId: step.id },
        reason: "Step must have a title",
      });
    }

    // Check dependencies exist
    for (const dep of step.dependsOn || []) {
      if (!stepIds.has(dep) && !spec.steps?.some((s) => s.id === dep)) {
        errors.push({
          stepId: step.id,
          target: { agentId: step.id },
          reason: `Step depends on unknown step: ${dep}`,
        });
      }
    }

    // Check step has a target
    const target = extractTarget(step as UnresolvedWorkflowStep);
    if (!target) {
      errors.push({
        stepId: step.id,
        target: { agentId: step.id },
        reason: "Step must have a target (agentId, role, or capability)",
      });
    }
  }

  // Check for circular dependencies (simple check)
  if (hasCircularDependencies(spec.steps || [])) {
    errors.push({
      stepId: "",
      target: { agentId: "" },
      reason: "Workflow has circular dependencies",
    });
  }

  return errors;
}

/**
 * Check for circular dependencies using DFS.
 */
function hasCircularDependencies(
  steps: UnresolvedWorkflowStep[]
): boolean {
  const visited = new Set<string>();
  const recursionStack = new Set<string>();

  function dfs(stepId: string): boolean {
    visited.add(stepId);
    recursionStack.add(stepId);

    const step = steps.find((s) => s.id === stepId);
    if (!step) return false;

    for (const dep of step.dependsOn || []) {
      if (!visited.has(dep)) {
        if (dfs(dep)) return true;
      } else if (recursionStack.has(dep)) {
        return true;
      }
    }

    recursionStack.delete(stepId);
    return false;
  }

  for (const step of steps) {
    if (!visited.has(step.id)) {
      if (dfs(step.id)) return true;
    }
  }

  return false;
}

/**
 * Format resolution errors for display.
 */
export function formatResolutionErrors(errors: ResolutionError[]): string {
  if (errors.length === 0) return "";

  const lines = ["Failed to resolve workflow:"];

  for (const error of errors) {
    if (error.stepId) {
      lines.push(`  - Step "${error.stepId}": ${error.reason}`);
    } else {
      lines.push(`  - ${error.reason}`);
    }
  }

  return lines.join("\n");
}
