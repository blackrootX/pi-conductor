// src/runtime/contextBuilder.ts - Build context for child session runs

import type { ResolvedWorkflowStep, StepResultEnvelope } from "../workflow/types";

export interface ChildSessionContext {
  systemPrompt: string;
  taskPrompt: string;
  stepTitle: string;
  agentName: string;
  agentId: string;
  dependencyOutputs: DependencyOutput[];
  userTask: string;
}

export interface DependencyOutput {
  stepId: string;
  stepTitle: string;
  summary: string;
  artifactValue: string;
}

/**
 * Build context for a child session run.
 */
export function buildChildSessionContext(
  step: ResolvedWorkflowStep,
  userTask: string,
  dependencyResults: Record<string, StepResultEnvelope>,
  allSteps: ResolvedWorkflowStep[]
): ChildSessionContext {
  // Collect dependency outputs
  const dependencyOutputs = collectDependencyOutputs(step, dependencyResults, allSteps);

  // Build the system prompt
  const systemPrompt = buildSystemPrompt(step.agent.name, step.agent.description);

  // Build the task prompt
  const taskPrompt = buildTaskPrompt(
    step.title,
    step.prompt,
    userTask,
    dependencyOutputs
  );

  return {
    systemPrompt,
    taskPrompt,
    stepTitle: step.title,
    agentName: step.agent.name,
    agentId: step.agent.id,
    dependencyOutputs,
    userTask,
  };
}

/**
 * Build the system prompt for a child session.
 */
function buildSystemPrompt(agentName: string, agentDescription?: string): string {
  const parts: string[] = [];

  parts.push(`You are ${agentName}.`);

  if (agentDescription) {
    parts.push("");
    parts.push(agentDescription);
  }

  parts.push("");
  parts.push("Your role is to complete the assigned task thoroughly and provide a structured result.");

  return parts.join("\n");
}

/**
 * Build the task prompt for a child session.
 */
function buildTaskPrompt(
  stepTitle: string,
  stepPrompt: string,
  userTask: string,
  dependencyOutputs: DependencyOutput[]
): string {
  const parts: string[] = [];

  // Task header
  parts.push(`# ${stepTitle}`);
  parts.push("");

  // User task context
  parts.push("## Task Context");
  parts.push(userTask);
  parts.push("");

  // Include dependency outputs if available
  if (dependencyOutputs.length > 0) {
    parts.push("## Previous Work");
    parts.push("");
    parts.push("The following previous steps have been completed:");
    parts.push("");

    for (const dep of dependencyOutputs) {
      parts.push(`### ${dep.stepTitle}`);
      parts.push(dep.summary);
      parts.push("");
    }
  }

  // Current step instruction
  parts.push("## Your Task");
  parts.push("");
  parts.push(stepPrompt);
  parts.push("");

  // Output format guidance
  parts.push("## Output Format");
  parts.push("");
  parts.push("Provide your response with the following structure:");
  parts.push("");
  parts.push("### Summary");
  parts.push("[A brief summary of what you did]");
  parts.push("");
  parts.push("### Result");
  parts.push("[The main output/result of your work]");
  parts.push("");
  parts.push("### Next Steps (if applicable)");
  parts.push("[Any recommendations for follow-up work]");

  return parts.join("\n");
}

/**
 * Collect outputs from completed dependencies.
 */
function collectDependencyOutputs(
  step: ResolvedWorkflowStep,
  dependencyResults: Record<string, StepResultEnvelope>,
  allSteps: ResolvedWorkflowStep[]
): DependencyOutput[] {
  if (!step.dependsOn || step.dependsOn.length === 0) {
    return [];
  }

  const outputs: DependencyOutput[] = [];

  for (const depId of step.dependsOn) {
    const result = dependencyResults[depId];
    const depStep = allSteps.find((s) => s.id === depId);

    if (result) {
      let artifactValue = result.summary;

      // Use artifact value if available
      if (result.artifact.type === "text" && typeof result.artifact.value === "string") {
        artifactValue = result.artifact.value;
      } else if (result.artifact.type === "json") {
        artifactValue = JSON.stringify(result.artifact.value, null, 2);
      }

      outputs.push({
        stepId: result.stepId,
        stepTitle: depStep?.title || result.stepId,
        summary: result.summary,
        artifactValue,
      });
    }
  }

  return outputs;
}

/**
 * Format dependency outputs for display.
 */
export function formatDependencyOutputs(outputs: DependencyOutput[]): string {
  if (outputs.length === 0) return "No previous work.";

  const lines: string[] = [];

  for (const output of outputs) {
    lines.push(`## ${output.stepTitle}`);
    lines.push("");
    lines.push(output.summary);
    lines.push("");
    lines.push("---");
    lines.push("");
  }

  return lines.join("\n");
}
