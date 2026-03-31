import type { AgentConfig } from "./agents.js";
import { runAgentSession } from "./agent-runner.js";
import type { SingleResult } from "./workflow-runtime.js";

export interface WorkflowAgentSessionOptions {
  cwd: string;
  agent: AgentConfig;
  task: string;
  defaultModel?: string;
  step: number;
  stepId: string;
  objective: string;
  signal?: AbortSignal;
  onUpdate?: (result: SingleResult) => void;
  systemPromptOverride?: string;
  toolsOverride?: string[];
}

export async function runWorkflowAgentSession(
  options: WorkflowAgentSessionOptions,
): Promise<SingleResult> {
  const result = await runAgentSession({
    cwd: options.cwd,
    agent: options.agent,
    task: options.task,
    defaultModel: options.defaultModel,
    signal: options.signal,
    systemPromptOverride: options.systemPromptOverride,
    toolsOverride: options.toolsOverride,
    onUpdate: options.onUpdate
      ? (partial) => {
          options.onUpdate!({
            ...partial,
            objective: options.objective,
            step: options.step,
            stepId: options.stepId,
            stderr: "",
          });
        }
      : undefined,
  });

  return {
    ...result,
    objective: options.objective,
    step: options.step,
    stepId: options.stepId,
    stderr: "",
  };
}
