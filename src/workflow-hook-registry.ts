import type { WorkflowRuntimeHooks } from "./workflow-hooks.js";

export interface WorkflowRuntimeHookContext {
  cwd: string;
  workflowName: string;
  task: string;
  defaultModel?: string;
}

export type WorkflowRuntimeHooksProvider = (
  context: WorkflowRuntimeHookContext,
) =>
  | WorkflowRuntimeHooks
  | void
  | Promise<WorkflowRuntimeHooks | void>;

type WorkflowRuntimeHooksSource = WorkflowRuntimeHooks | WorkflowRuntimeHooksProvider;

let workflowRuntimeHooksSource: WorkflowRuntimeHooksSource | undefined;

export function setWorkflowRuntimeHooks(hooks: WorkflowRuntimeHooks): void {
  workflowRuntimeHooksSource = hooks;
}

export function setWorkflowRuntimeHooksProvider(
  provider: WorkflowRuntimeHooksProvider,
): void {
  workflowRuntimeHooksSource = provider;
}

export function clearWorkflowRuntimeHooks(): void {
  workflowRuntimeHooksSource = undefined;
}

export async function resolveWorkflowRuntimeHooks(
  context: WorkflowRuntimeHookContext,
): Promise<WorkflowRuntimeHooks> {
  const source = workflowRuntimeHooksSource;
  if (!source) return {};

  if (typeof source === "function") {
    const resolved = await source(context);
    return resolved ?? {};
  }

  return source;
}
