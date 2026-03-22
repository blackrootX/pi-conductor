import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import type { AgentRegistry } from "../registry";
import type { AgentSpec } from "../types";
import {
  cleanupWorkflowStorage,
  executeWorkflowCommand,
  getConfiguredWorkflows,
  getWorkflowSettingsContext,
  parseWorkflowCommandArgs,
  type EffectiveWorkflowSettings,
  type SettingsScope,
  type WorkflowCommandExecution,
  type WorkflowCommandObserver,
  type WorkflowDisplayStrategy,
  type WorkflowMultiplexer,
  type WorkflowCleanupTarget,
  writeWorkflowSettings,
} from "./commands/workflow";
import {
  getWorkflowDefinition,
  listWorkflowDefinitions,
  saveWorkflowAgentListTemplate,
  saveWorkflowTemplate,
} from "../workflow/templates";

export interface WorkflowPiCleanupNotice {
  target: WorkflowCleanupTarget;
  summary: string;
}

interface WorkflowPiUiOptions {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  parsedArgs: ReturnType<typeof parseWorkflowCommandArgs>;
  rawArgs: string;
  registry: AgentRegistry;
  observer: WorkflowCommandObserver;
  onCleanupComplete?: (notice: WorkflowPiCleanupNotice) => void;
}

interface NativeWorkflowAction {
  label: string;
  run: () => Promise<WorkflowCommandExecution | void>;
}

export async function runWorkflowCommandFromPiUi(
  options: WorkflowPiUiOptions
): Promise<WorkflowCommandExecution | void> {
  const { rawArgs, parsedArgs } = options;

  if (shouldUseNativeWorkflowUi(parsedArgs, rawArgs.trim())) {
    return runNativeWorkflowUi(options);
  }

  return executeWorkflowFromExtension(options.ctx, options.registry, options.observer, {
    ...parsedArgs,
    cwd: options.ctx.cwd,
  });
}

function shouldUseNativeWorkflowUi(
  parsedArgs: ReturnType<typeof parseWorkflowCommandArgs>,
  rawArgs: string
): boolean {
  if (parsedArgs.settings || rawArgs === "settings") {
    return true;
  }

  return !(
    parsedArgs.help ||
    parsedArgs.list ||
    parsedArgs.show ||
    parsedArgs.add ||
    parsedArgs.remove ||
    parsedArgs.run ||
    parsedArgs.save ||
    parsedArgs.cleanup
  );
}

async function runNativeWorkflowUi(
  options: WorkflowPiUiOptions
): Promise<WorkflowCommandExecution | void> {
  const { ctx, parsedArgs } = options;

  if (parsedArgs.settings || parsedArgs.task === "settings") {
    await runNativeWorkflowSettings(ctx);
    return;
  }

  if (parsedArgs.task?.trim()) {
    return promptAndRunWorkflowFromPiUi(parsedArgs.task.trim(), options);
  }

  const actions = createNativeWorkflowActions(options);
  const choice = await ctx.ui.select(
    "Workflow",
    actions.map((action) => action.label)
  );

  if (!choice) {
    ctx.ui.notify("Workflow menu cancelled", "info");
    return;
  }

  const action = actions.find((entry) => entry.label === choice);
  return action?.run();
}

function createNativeWorkflowActions(
  options: WorkflowPiUiOptions
): NativeWorkflowAction[] {
  const { pi, ctx, parsedArgs, registry } = options;

  return [
    {
      label: "Run workflow",
      run: () => promptAndRunWorkflowFromPiUi(undefined, options),
    },
    {
      label: "List workflows",
      run: async () => {
        await showConfiguredWorkflowsInPi(ctx);
      },
    },
    {
      label: "Add workflow",
      run: async () => {
        await addWorkflowFromPiUi(ctx, registry);
      },
    },
    {
      label: "Remove workflow",
      run: async () => {
        await removeWorkflowFromPiUi(ctx);
      },
    },
    {
      label: "Save workflow template",
      run: async () => {
        await saveWorkflowTemplateFromPiUi(ctx);
      },
    },
    {
      label: "Cleanup artifacts",
      run: async () => {
        await cleanupWorkflowFromPiUi(pi, ctx, options.onCleanupComplete);
      },
    },
    {
      label: "Settings",
      run: async () => {
        await runNativeWorkflowSettings(ctx);
      },
    },
  ];
}

async function promptAndRunWorkflowFromPiUi(
  initialTask: string | undefined,
  options: WorkflowPiUiOptions
): Promise<WorkflowCommandExecution | void> {
  const workflow = await selectWorkflowForRun(options.ctx);
  if (!workflow) {
    return;
  }

  const task = initialTask ?? await promptForTask(options.ctx, workflow.id);
  if (!task) {
    return;
  }

  return executeWorkflowFromExtension(options.ctx, options.registry, options.observer, {
    ...options.parsedArgs,
    run: workflow.id,
    task,
    cwd: options.ctx.cwd,
  });
}

function createWorkflowLockMessage(theme: ExtensionCommandContext["ui"]["theme"]) {
  const text = new Text(
    `${theme.fg("accent", theme.bold("Workflow running"))}\n\nThe main Pi input is locked until this workflow finishes.`,
    2,
    1
  );

  return {
    render: (width: number) => text.render(width),
    invalidate: () => text.invalidate(),
    handleInput: (_data: string) => true,
  };
}

async function runWorkflowWithInputLock<T>(
  ctx: ExtensionCommandContext,
  run: () => Promise<T>
): Promise<T> {
  let handle: { close?: () => void } | undefined;
  const lockPromise = ctx.ui.custom(
    (_tui, theme) => createWorkflowLockMessage(theme),
    {
      onHandle: (uiHandle) => {
        handle = uiHandle as { close?: () => void };
      },
    }
  ).catch(() => undefined);

  try {
    return await run();
  } finally {
    handle?.close?.();
    await lockPromise;
  }
}

async function executeWorkflowFromExtension(
  ctx: ExtensionCommandContext,
  registry: AgentRegistry,
  observer: WorkflowCommandObserver,
  options: ReturnType<typeof parseWorkflowCommandArgs> & { cwd: string }
): Promise<WorkflowCommandExecution | void> {
  const runCommand = () => executeWorkflowCommand(options, registry, observer);
  return options.run
    ? runWorkflowWithInputLock(ctx, runCommand)
    : runCommand();
}

async function selectWorkflowForRun(
  ctx: ExtensionCommandContext
): Promise<{ id: string; name: string; description?: string } | undefined> {
  const workflows = await getConfiguredWorkflows(ctx.cwd);
  if (workflows.length === 0) {
    throw new Error("No workflows found. Create one with /workflow -> Add workflow.");
  }

  const labels = workflows.map((workflow) =>
    workflow.description ? `${workflow.id} - ${workflow.description}` : workflow.id
  );
  const selected = await pickFromList(ctx, "Select workflow", labels);
  return selected ? workflows[labels.indexOf(selected)] : undefined;
}

async function showConfiguredWorkflowsInPi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = await getConfiguredWorkflows(ctx.cwd);
  if (workflows.length === 0) {
    ctx.ui.notify("No workflows found", "info");
    return;
  }

  ctx.ui.setWidget("workflow-config", workflows.map((workflow, index) =>
    `${index + 1}. ${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""}`
  ));
  ctx.ui.notify(`Loaded ${workflows.length} workflow(s)`, "info");
}

async function addWorkflowFromPiUi(
  ctx: ExtensionCommandContext,
  registry: AgentRegistry
): Promise<void> {
  const scope = await ctx.ui.select("Create workflow in", ["project", "user"]);
  if (!scope) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    return;
  }

  const agents = (await registry.listAgents())
    .sort((a, b) => a.id.localeCompare(b.id));

  if (agents.length === 0) {
    ctx.ui.notify("No agents available to build a workflow", "warning");
    return;
  }

  const selectedAgents = await selectWorkflowAgents(ctx, agents);
  if (selectedAgents.length === 0) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    ctx.ui.setWidget("workflow-builder", []);
    return;
  }

  const defaultWorkflowId = selectedAgents.map((agent) => agent.id).join("-");
  const workflowId = (await ctx.ui.input("Workflow id:", defaultWorkflowId))?.trim();
  if (!workflowId) {
    ctx.ui.notify("Workflow creation cancelled", "info");
    ctx.ui.setWidget("workflow-builder", []);
    return;
  }

  const description = (await ctx.ui.input("Description (optional):", ""))?.trim() || undefined;

  try {
    await saveWorkflowAgentListTemplate(
      workflowId,
      selectedAgents.map((agent) => agent.id),
      scope as SettingsScope,
      ctx.cwd,
      description
    );
    ctx.ui.notify(`Created workflow: ${workflowId} (${scope})`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to create workflow: ${message}`, "error");
  } finally {
    ctx.ui.setWidget("workflow-builder", []);
  }
}

async function removeWorkflowFromPiUi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = (await listWorkflowDefinitions(ctx.cwd)).filter((workflow) => workflow.source !== "built-in");
  if (workflows.length === 0) {
    ctx.ui.notify("No custom workflows available to remove", "info");
    return;
  }

  const selected = await ctx.ui.select(
    "Remove workflow",
    workflows.map((workflow) => `${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""} [${workflow.source}]`)
  );
  if (!selected) {
    return;
  }

  const workflowId = selected.split(" [")[0].split(" - ")[0];
  await executeWorkflowCommand({ remove: workflowId, cwd: ctx.cwd });
  ctx.ui.notify(`Removed workflow: ${workflowId}`, "info");
}

async function saveWorkflowTemplateFromPiUi(ctx: ExtensionCommandContext): Promise<void> {
  const workflows = await listWorkflowDefinitions(ctx.cwd);
  const selected = await ctx.ui.select(
    "Save workflow template",
    workflows.map((workflow) => `${workflow.id}${workflow.description ? ` - ${workflow.description}` : ""} [${workflow.source}]`)
  );
  if (!selected) {
    return;
  }

  const workflowId = selected.split(" [")[0].split(" - ")[0];
  const resolved = await getWorkflowDefinition(workflowId, ctx.cwd);
  if (!resolved) {
    ctx.ui.notify(`Unknown workflow: ${workflowId}`, "error");
    return;
  }

  const targetId = (await ctx.ui.input("New workflow template id:", workflowId))?.trim();
  if (!targetId) {
    ctx.ui.notify("Template save cancelled", "info");
    return;
  }

  const scope = await ctx.ui.select("Save workflow template to", ["project", "user"]);
  if (!scope) {
    ctx.ui.notify("Template save cancelled", "info");
    return;
  }

  try {
    await saveWorkflowTemplate(
      {
        ...resolved.workflow,
        id: targetId,
      },
      scope as "project" | "user",
      ctx.cwd
    );
    ctx.ui.notify(`Saved workflow template: ${targetId} (${scope})`, "info");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Failed to save workflow template: ${message}`, "error");
  }
}

async function cleanupWorkflowFromPiUi(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  onCleanupComplete?: (notice: WorkflowPiCleanupNotice) => void
): Promise<void> {
  const choice = await ctx.ui.select("Cleanup workflow artifacts", [
    "Session scratch data",
    "Run artifacts",
    "Everything",
  ]);

  if (!choice) {
    ctx.ui.notify("Cleanup cancelled", "info");
    return;
  }

  const target =
    choice === "Session scratch data" ? "sessions" :
    choice === "Run artifacts" ? "runs" : "all";

  try {
    const summary = await cleanupWorkflowStorage(target, ctx.cwd);
    ctx.ui.notify(summary, "info");
    onCleanupComplete?.({ target, summary });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.ui.notify(`Cleanup failed: ${message}`, "error");
  }
}

async function runNativeWorkflowSettings(ctx: ExtensionCommandContext): Promise<void> {
  const context = await getWorkflowSettingsContext(ctx.cwd);
  const settings: EffectiveWorkflowSettings = { ...context.settings };
  let scope: SettingsScope = context.scope;

  while (true) {
    const choice = await ctx.ui.select("Workflow settings", [
      `Multiplexer: ${settings.conductorWorkflowMultiplexer}`,
      `Display: ${settings.conductorWorkflowDisplay}`,
      `Save scope: ${scope}`,
      "Save",
    ]);

    if (!choice) {
      ctx.ui.notify("Settings cancelled", "info");
      return;
    }

    if (choice.startsWith("Multiplexer:")) {
      const selected = await ctx.ui.select("Select multiplexer", ["none", "zellij"]);
      if (selected) {
        settings.conductorWorkflowMultiplexer = selected as WorkflowMultiplexer;
      }
      continue;
    }

    if (choice.startsWith("Display:")) {
      if (settings.conductorWorkflowMultiplexer === "none") {
        ctx.ui.notify("Display is only used when multiplexer is zellij", "warning");
        continue;
      }
      const selected = await ctx.ui.select("Select display strategy", ["main-window", "split-pane"]);
      if (selected) {
        settings.conductorWorkflowDisplay = selected as WorkflowDisplayStrategy;
      }
      continue;
    }

    if (choice.startsWith("Save scope:")) {
      const selected = await ctx.ui.select("Save settings to", ["project", "user"]);
      if (selected) {
        scope = selected as SettingsScope;
      }
      continue;
    }

    await writeWorkflowSettings({
      conductorWorkflowMultiplexer: settings.conductorWorkflowMultiplexer,
      conductorWorkflowDisplay: settings.conductorWorkflowDisplay,
    }, scope, ctx.cwd);
    ctx.ui.notify(`Workflow settings saved to ${scope} settings`, "info");
    return;
  }
}

async function pickFromList(
  ctx: ExtensionCommandContext,
  title: string,
  items: string[]
): Promise<string | undefined> {
  return items.length === 0 ? undefined : ctx.ui.select(title, items);
}

async function promptForTask(
  ctx: ExtensionCommandContext,
  workflowId: string
): Promise<string | undefined> {
  const value = await ctx.ui.input(`Task for ${workflowId}:`, "Describe the work");
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

async function selectWorkflowAgents(
  ctx: ExtensionCommandContext,
  agents: AgentSpec[]
): Promise<AgentSpec[]> {
  const selected: AgentSpec[] = [];

  while (true) {
    const lines = [
      "Building workflow",
      ...selected.map((agent, index) => `${index + 1}. ${agent.id}${agent.description ? ` - ${agent.description}` : ""}`),
    ];
    ctx.ui.setWidget("workflow-builder", lines);

    const options = [
      ...agents.map((agent) => `${agent.id}${agent.description ? ` - ${agent.description}` : ""} [${agent.source}]`),
      "Done",
    ];

    const choice = await ctx.ui.select("Select agent for workflow", options);
    if (!choice) {
      return [];
    }

    if (choice === "Done") {
      if (selected.length === 0) {
        ctx.ui.notify("Select at least one agent before finishing", "warning");
        continue;
      }
      return selected;
    }

    const agentId = choice.split(" [")[0].split(" - ")[0];
    const agent = agents.find((entry) => entry.id === agentId);
    if (!agent) {
      ctx.ui.notify(`Unknown agent: ${agentId}`, "warning");
      continue;
    }

    selected.push(agent);
  }
}
