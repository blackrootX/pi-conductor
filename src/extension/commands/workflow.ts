// src/extension/commands/workflow.ts - /workflow command implementation

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { getPreset } from "../../workflow/presets";
import { mergeWorkflowSkills } from "../../workflow/skills";
import { getWorkflowDefinition, listWorkflowDefinitions, saveWorkflowTemplate } from "../../workflow/templates";
import type { WorkflowSpec, WorkflowRunResult } from "../../workflow/types";
import type { AgentRegistry } from "../../registry";
import { createOrchestrator } from "../../runtime/orchestrator";
import type { ProgressEvent } from "../../runtime/orchestrator";
import type { WorkflowApprovalHandler } from "../../workflow/approval";
import {
  DefaultSessionRunner,
  LocalProcessRunner,
} from "../../runtime/childSessionRunner";

export interface WorkflowCommandOptions {
  /** Project cwd for workflow config/template resolution */
  cwd?: string;
  /** List configured workflows */
  list?: boolean;
  /** Show a specific workflow */
  show?: string;
  /** Show help */
  help?: boolean;
  /** Add a workflow to settings */
  add?: string;
  /** Remove a workflow from settings */
  remove?: string;
  /** Run a workflow */
  run?: string;
  /** Save a workflow as a template */
  save?: string;
  /** Target id when saving a template */
  saveAs?: string;
  /** Template save scope */
  scope?: "project" | "user";
  /** Task description */
  task?: string;
  /** Runner type */
  runner?: "local-process" | "default" | "zellij";
  /** Verbose output */
  verbose?: boolean;
  /** Working directory for run artifacts */
  workingDir?: string;
  /** Force sequential execution (maxParallelism=1) */
  sequential?: boolean;
  /** Open workflow settings menu */
  settings?: boolean;
  /** Cleanup workflow artifacts */
  cleanup?: WorkflowCleanupTarget;
  /** Parse/validation errors captured from command args */
  parseErrors?: string[];
}

export interface WorkflowCommandObserver {
  onProgress?: (event: ProgressEvent) => void;
  onResult?: (result: WorkflowRunResult, durationMs: number) => void;
  onApprovalRequest?: WorkflowApprovalHandler;
}

export interface WorkflowCommandExecution {
  workflowId: string;
  result: WorkflowRunResult;
  durationMs: number;
}

const WORKFLOW_RUN_RETENTION_COUNT = 20;
export type WorkflowCleanupTarget = "sessions" | "runs" | "all";

/**
 * Execute the /workflow command.
 */
export async function executeWorkflowCommand(
  options: WorkflowCommandOptions,
  registry?: AgentRegistry,
  observer?: WorkflowCommandObserver
): Promise<WorkflowCommandExecution | void> {
  if (options.parseErrors && options.parseErrors.length > 0) {
    throw new Error(options.parseErrors.join("\n"));
  }

  if (options.help) {
    console.log(getHelpText());
    return;
  }

  if (options.settings) {
    throw new Error("Interactive workflow settings are available through the Pi extension UI. Use /workflow inside Pi.");
  }

  if (options.add) {
    await addWorkflow(options.add, options.cwd);
    return;
  }

  if (options.remove) {
    await removeWorkflow(options.remove, options.cwd);
    return;
  }

  if (options.save) {
    await saveWorkflow(options.save, options);
    return;
  }

  if (options.cleanup) {
    const summary = await cleanupWorkflowStorage(options.cleanup, options.workingDir || options.cwd || process.cwd());
    console.log(summary);
    return;
  }

  // Handle list option
  if (options.list) {
    await listConfiguredWorkflows(options.cwd);
    return;
  }

  // Handle show option
  if (options.show) {
    await showWorkflow(options.show, options.cwd);
    return;
  }

  // Handle run option
  if (options.run) {
    if (!registry) {
      throw new Error("Agent registry is required to run workflows");
    }
    return runWorkflow(options.run, options, registry, observer);
  }

  if (!registry) {
    throw new Error("Agent registry is required to run workflows");
  }

  throw new Error(
    "Interactive workflow menus are available through the Pi extension UI. Use /workflow inside Pi, or use direct subcommands like /workflow run, /workflow list, /workflow add, or /workflow remove."
  );
}

/**
 * List configured workflows.
 */
async function listConfiguredWorkflows(cwd = process.cwd()): Promise<void> {
  const configured = await getConfiguredWorkflowIds(cwd);

  console.log("\nConfigured Workflows:\n");

  if (configured.length === 0) {
    console.log("  No workflows configured.");
    console.log("  Use '/workflow add <workflow-id>' to add one.");
    console.log("");
    return;
  }

  for (let i = 0; i < configured.length; i++) {
    const workflowId = configured[i];
    const preset = await getWorkflowDefinition(workflowId, cwd);
    const label = i === 0 ? " (default)" : "";

    console.log(`  ${i + 1}. ${workflowId}${label}`);
    if (preset) {
      console.log(`     ${preset.workflow.name}`);
      if (preset.workflow.description) {
        console.log(`     ${preset.workflow.description}`);
      }
      console.log(`     Source: ${preset.source}`);
    } else {
      console.log("     Unknown workflow ID in settings");
    }
    console.log("");
  }
}

async function saveWorkflowSettings(
  settings: EffectiveWorkflowSettings,
  scope: SettingsScope,
  cwd = process.cwd()
): Promise<void> {
  const settingsPath = scope === "project"
    ? getProjectSettingsPath(cwd)
    : getUserSettingsPath();
  const existingSettings = await readRawSettingsFile(settingsPath);

  const newSettings: WorkflowSettings = {
    ...existingSettings,
    conductorWorkflow: settings.conductorWorkflow,
    conductorWorkflowMultiplexer: settings.conductorWorkflowMultiplexer,
    conductorWorkflowDisplay: settings.conductorWorkflowDisplay,
  };

  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(newSettings, null, 2) + "\n", "utf8");
}

async function isZellijAvailable(): Promise<boolean> {
  const { execSync } = await import("node:child_process");
  try {
    execSync("command -v zellij", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Show details of a specific workflow.
 */
async function showWorkflow(workflowId: string, cwd = process.cwd()): Promise<void> {
  const resolved = await getWorkflowDefinition(workflowId, cwd);
  const workflow = resolved?.workflow;

  if (!workflow) {
    console.error(`Unknown workflow: ${workflowId}`);
    console.log(`Run '/workflow --list' to see available workflows.`);
    return;
  }

  console.log(`\n# ${workflow.name}`);
  console.log(`**ID:** ${workflow.id}`);
  if (resolved) {
    console.log(`**Source:** ${resolved.source}`);
  }
  if (workflow.description) {
    console.log(`\n${workflow.description}`);
  }

  if (workflow.sharedSkills && workflow.sharedSkills.length > 0) {
    console.log("\n## Shared Skills\n");
    console.log(`- ${workflow.sharedSkills.join(", ")}`);
  }

  console.log("\n## Steps\n");

  for (const step of workflow.steps) {
    const target = getStepTargetDescription(step);
    const effectiveSkills = mergeWorkflowSkills(workflow.sharedSkills, step.skills);
    console.log(`- **${step.title}**`);
    console.log(`  - ID: ${step.id}`);
    console.log(`  - Target: ${target}`);
    if (step.dependsOn && step.dependsOn.length > 0) {
      console.log(`  - Depends on: ${step.dependsOn.join(", ")}`);
    }
    if (effectiveSkills.length > 0) {
      console.log(`  - Skills: ${effectiveSkills.join(", ")}`);
    }
    if (step.requiresApproval) {
      console.log("  - Requires approval: yes");
    }
    console.log(`  - Prompt: ${step.prompt}`);
    console.log("");
  }

  console.log("## Policy\n");
  console.log(`- Max parallelism: ${workflow.policy?.maxParallelism ?? 1}`);
  console.log(`- On failure: ${workflow.policy?.onStepFailure ?? "abort"}`);

  console.log("\n## Synthesis\n");
  console.log(`- Strategy: ${workflow.synthesis?.strategy ?? "lead"}`);
  console.log("");
}

/**
 * Get a human-readable description of a step's target.
 */
function getStepTargetDescription(step: WorkflowSpec["steps"][0]): string {
  if ("agentId" in step) return `agent: ${(step as { agentId: string }).agentId}`;
  if ("role" in step) return `role: ${(step as { role: string }).role}`;
  if ("capability" in step) return `capability: ${(step as { capability: string }).capability}`;
  return "unknown";
}

function resolveWorkflowSelection(
  selection: string,
  configured: string[]
): { workflowId?: string; suggestions: string[] } {
  if (!selection && configured.length > 0) {
    return { workflowId: configured[0], suggestions: [] };
  }

  const numeric = Number(selection);
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= configured.length) {
    return { workflowId: configured[numeric - 1], suggestions: [] };
  }

  const exact = configured.find((workflowId) => workflowId === selection);
  if (exact) {
    return { workflowId: exact, suggestions: [] };
  }

  const lowerSelection = selection.toLowerCase();

  const caseInsensitive = configured.find(
    (workflowId) => workflowId.toLowerCase() === lowerSelection
  );
  if (caseInsensitive) {
    return { workflowId: caseInsensitive, suggestions: [] };
  }

  const prefixMatches = configured.filter(
    (workflowId) => workflowId.toLowerCase().startsWith(lowerSelection)
  );
  if (prefixMatches.length === 1) {
    return { workflowId: prefixMatches[0], suggestions: [] };
  }

  const tokenMatches = configured.filter((workflowId) =>
    workflowId.toLowerCase().includes(lowerSelection)
  );
  if (tokenMatches.length === 1) {
    return { workflowId: tokenMatches[0], suggestions: [] };
  }

  return {
    workflowId: undefined,
    suggestions: dedupeSuggestions([...prefixMatches, ...tokenMatches]).slice(0, 3),
  };
}

async function addWorkflow(workflowId: string, cwd = process.cwd()): Promise<void> {
  const normalizedWorkflowId = await resolveWorkflowIdForAdd(workflowId, cwd);
  const preset = normalizedWorkflowId ? await getWorkflowDefinition(normalizedWorkflowId, cwd) : undefined;
  if (!preset) {
    const available = (await listWorkflowDefinitions()).map((entry) => entry.id).join(", ");
    throw new Error(`Unknown workflow: ${workflowId}. Available workflows: ${available}`);
  }

  const settings = await readWorkflowSettings(cwd);
  const configured = settings.conductorWorkflow ?? [];

  if (configured.includes(preset.workflow.id)) {
    console.log(`Workflow already configured: ${preset.workflow.id}`);
    return;
  }

  settings.conductorWorkflow = [...configured, preset.workflow.id];
  await writeWorkflowSettings(settings, "project", cwd);

  console.log(`Added workflow: ${preset.workflow.id}`);
}

async function removeWorkflow(workflowId: string, cwd = process.cwd()): Promise<void> {
  const normalizedWorkflowId = await resolveWorkflowIdForAdd(workflowId, cwd);
  if (!normalizedWorkflowId) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }

  const settings = await readWorkflowSettings(cwd);
  const configured = settings.conductorWorkflow ?? [];

  if (!configured.includes(normalizedWorkflowId)) {
    console.log(`Workflow not configured: ${normalizedWorkflowId}`);
    return;
  }

  settings.conductorWorkflow = configured.filter((id) => id !== normalizedWorkflowId);
  await writeWorkflowSettings(settings, "project", cwd);

  console.log(`Removed workflow: ${normalizedWorkflowId}`);
}

async function saveWorkflow(
  workflowId: string,
  options: WorkflowCommandOptions
): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = await getWorkflowDefinition(workflowId, cwd);
  if (!resolved) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }

  const scope = options.scope ?? "project";
  const targetId = options.saveAs?.trim() || workflowId;
  const workflowToSave: WorkflowSpec = {
    ...resolved.workflow,
    id: targetId,
  };

  await saveWorkflowTemplate(workflowToSave, scope, cwd);
  console.log(`Saved workflow template: ${targetId} (${scope})`);
}

export async function resolveWorkflowIdForAdd(inputId: string, cwd = process.cwd()): Promise<string | undefined> {
  const presets = await listWorkflowDefinitions(cwd);
  const exact = presets.find((preset) => preset.id === inputId);
  if (exact) return exact.id;

  const lowerInput = inputId.toLowerCase();

  const caseInsensitive = presets.find(
    (preset) => preset.id.toLowerCase() === lowerInput
  );
  if (caseInsensitive) return caseInsensitive.id;

  const prefixMatches = presets.filter(
    (preset) => preset.id.toLowerCase().startsWith(lowerInput)
  );
  if (prefixMatches.length === 1) return prefixMatches[0].id;

  const containsMatches = presets.filter(
    (preset) => preset.id.toLowerCase().includes(lowerInput)
  );
  if (containsMatches.length === 1) return containsMatches[0].id;

  return undefined;
}

function dedupeSuggestions(values: string[]): string[] {
  return Array.from(new Set(values));
}

export interface WorkflowSettings {
  conductorWorkflow?: string[];
  conductorWorkflowMultiplexer?: WorkflowMultiplexer;
  conductorWorkflowDisplay?: WorkflowDisplayStrategy;
}

export type WorkflowMultiplexer = "none" | "zellij";
export type WorkflowDisplayStrategy = "main-window" | "split-pane";
export type SettingsScope = "project" | "user";

export interface EffectiveWorkflowSettings {
  conductorWorkflow: string[];
  conductorWorkflowMultiplexer: WorkflowMultiplexer;
  conductorWorkflowDisplay: WorkflowDisplayStrategy;
}

function getUserSettingsPath(): string {
  return path.join(os.homedir(), ".pi", "agent", "settings.json");
}

function getProjectSettingsPath(cwd = process.cwd()): string {
  return path.join(cwd, ".pi", "agent", "settings.json");
}

async function readRawSettingsFile(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    const content = await fs.readFile(settingsPath, "utf8");
    const parsed = JSON.parse(content);
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function readWorkflowSettingsFromFile(settingsPath: string): Promise<WorkflowSettings> {
  const parsed = await readRawSettingsFile(settingsPath);
  return {
    conductorWorkflow: Array.isArray(parsed.conductorWorkflow)
      ? parsed.conductorWorkflow.filter((entry): entry is string => typeof entry === "string")
      : undefined,
    conductorWorkflowMultiplexer: parsed.conductorWorkflowMultiplexer === undefined
      ? undefined
      : parseMultiplexer(parsed.conductorWorkflowMultiplexer),
    conductorWorkflowDisplay: parsed.conductorWorkflowDisplay === undefined
      ? undefined
      : parseDisplayStrategy(parsed.conductorWorkflowDisplay),
  };
}

function parseMultiplexer(value: unknown): WorkflowMultiplexer {
  if (value === "zellij") return "zellij";
  return "none";
}

function parseDisplayStrategy(value: unknown): WorkflowDisplayStrategy {
  if (value === "split-pane") return "split-pane";
  return "main-window";
}

async function readWorkflowSettings(cwd = process.cwd()): Promise<WorkflowSettings> {
  const projectSettings = await readWorkflowSettingsFromFile(getProjectSettingsPath(cwd));

  const hasProjectSettings = hasExplicitWorkflowSettings(projectSettings);

  if (hasProjectSettings) {
    return projectSettings;
  }

  return readWorkflowSettingsFromFile(getUserSettingsPath());
}

function hasExplicitWorkflowSettings(settings: WorkflowSettings): boolean {
  return (
    settings.conductorWorkflow !== undefined ||
    settings.conductorWorkflowMultiplexer !== undefined ||
    settings.conductorWorkflowDisplay !== undefined
  );
}

async function getEffectiveWorkflowSettings(cwd = process.cwd()): Promise<EffectiveWorkflowSettings> {
  const settings = await readWorkflowSettings(cwd);
  return {
    conductorWorkflow: settings.conductorWorkflow ?? [],
    conductorWorkflowMultiplexer: settings.conductorWorkflowMultiplexer ?? "none",
    conductorWorkflowDisplay: settings.conductorWorkflowDisplay ?? "main-window",
  };
}

export async function getWorkflowSettingsContext(
  cwd = process.cwd()
): Promise<{ settings: EffectiveWorkflowSettings; scope: SettingsScope }> {
  const projectSettings = await readWorkflowSettingsFromFile(getProjectSettingsPath(cwd));
  if (hasExplicitWorkflowSettings(projectSettings)) {
    return {
      settings: {
        conductorWorkflow: projectSettings.conductorWorkflow ?? [],
        conductorWorkflowMultiplexer: projectSettings.conductorWorkflowMultiplexer ?? "none",
        conductorWorkflowDisplay: projectSettings.conductorWorkflowDisplay ?? "main-window",
      },
      scope: "project",
    };
  }

  const userSettings = await readWorkflowSettingsFromFile(getUserSettingsPath());
  return {
    settings: {
      conductorWorkflow: userSettings.conductorWorkflow ?? [],
      conductorWorkflowMultiplexer: userSettings.conductorWorkflowMultiplexer ?? "none",
      conductorWorkflowDisplay: userSettings.conductorWorkflowDisplay ?? "main-window",
    },
    scope: hasExplicitWorkflowSettings(userSettings) ? "user" : "project",
  };
}

export async function writeWorkflowSettings(
  settings: WorkflowSettings,
  scope: "project" | "user" = "project",
  cwd = process.cwd()
): Promise<void> {
  const settingsPath = scope === "project"
    ? getProjectSettingsPath(cwd)
    : getUserSettingsPath();
  await fs.mkdir(path.dirname(settingsPath), { recursive: true });
  await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2) + "\n", "utf8");
}

async function getConfiguredWorkflowIds(cwd = process.cwd()): Promise<string[]> {
  const settings = await readWorkflowSettings(cwd);
  return settings.conductorWorkflow ?? [];
}

export async function getConfiguredWorkflows(cwd = process.cwd()): Promise<Array<{ id: string; name: string; description?: string }>> {
  const ids = await getConfiguredWorkflowIds(cwd);
  const definitions = await Promise.all(ids.map((id) => getWorkflowDefinition(id, cwd)));
  return ids.map((id, index) => {
    const preset = definitions[index];
    return {
      id,
      name: preset?.workflow.name ?? id,
      description: preset?.workflow.description,
    };
  });
}

// ============================================================================
// Runner Selection
// ============================================================================

interface RunnerInfo {
  runner: import("../../runtime/childSessionRunner").SessionRunner;
  name: string;
}

async function determineRunner(
  cliRunner: WorkflowCommandOptions["runner"],
  effectiveSettings: EffectiveWorkflowSettings,
  runDir: string,
  workingDir: string,
  options: WorkflowCommandOptions
): Promise<RunnerInfo> {
  // Check if explicitly specified via CLI
  if (cliRunner === "local-process") {
    return {
      runner: createLocalProcessRunner(workingDir, options.verbose),
      name: "local-process",
    };
  }

  if (cliRunner === "default") {
    return {
      runner: createDefaultSessionRunner(workingDir, options.verbose),
      name: "default",
    };
  }

  // CLI can force zellij mode
  if (cliRunner === "zellij" || effectiveSettings.conductorWorkflowMultiplexer === "zellij") {
    return createZellijRunner(
      effectiveSettings,
      runDir,
      workingDir,
      options.verbose
    );
  }

  // Default to local-process
  return {
    runner: createLocalProcessRunner(workingDir, options.verbose),
    name: "local-process",
  };
}

function createLocalProcessRunner(workingDir: string, verbose?: boolean) {
  return new LocalProcessRunner({
    workingDir,
    onStatusChange: (stepId, status) => {
      if (verbose) {
        console.log(`  [${status}] ${stepId}`);
      }
    },
  });
}

function createDefaultSessionRunner(workingDir: string, verbose?: boolean) {
  return new DefaultSessionRunner({
    workingDir,
    writeResultsToDisk: true,
    onStatusChange: (stepId, status) => {
      if (verbose) {
        console.log(`  [${status}] ${stepId}`);
      }
    },
  });
}

async function createZellijRunner(
  effectiveSettings: EffectiveWorkflowSettings,
  runDir: string,
  workingDir: string,
  verbose?: boolean
): Promise<RunnerInfo> {
  const inZellij = Boolean(process.env.ZELLIJ);
  const zellijAvailable = await isZellijAvailable();

  if (!zellijAvailable) {
    console.warn("\n⚠ Zellij not available, falling back to local-process runner.");
    return {
      runner: createLocalProcessRunner(workingDir, verbose),
      name: "local-process (zellij unavailable)",
    };
  }

  if (inZellij) {
    console.log("\n🟢 Running inside Zellij session");
    console.log(`   Display strategy: ${effectiveSettings.conductorWorkflowDisplay}`);

    // Inside Zellij: use current session with configured display strategy
    const { ZellijRunner } = await import("../../runtime/zellijRunner");
    return {
      runner: new ZellijRunner({
        workingDir,
        displayStrategy: effectiveSettings.conductorWorkflowDisplay,
        inZellijSession: true,
        onStatusChange: (stepId, status) => {
          if (verbose) {
            console.log(`  [${status}] ${stepId}`);
          }
        },
      }),
      name: `zellij (${effectiveSettings.conductorWorkflowDisplay})`,
    };
  } else {
    console.log("\n🔵 Starting detached Zellij session for workflow");

    // Outside Zellij: create detached session
    const { ZellijRunner } = await import("../../runtime/zellijRunner");
    return {
      runner: new ZellijRunner({
        workingDir,
        displayStrategy: effectiveSettings.conductorWorkflowDisplay,
        inZellijSession: false,
        onStatusChange: (stepId, status) => {
          if (verbose) {
            console.log(`  [${status}] ${stepId}`);
          }
        },
      }),
      name: `zellij (detached ${effectiveSettings.conductorWorkflowDisplay})`,
    };
  }
}

// ============================================================================
// Workflow Execution
// ============================================================================

/**
 * Run a workflow with the given ID.
 */
async function runWorkflow(
  workflowId: string,
  options: WorkflowCommandOptions,
  registry: AgentRegistry,
  observer?: WorkflowCommandObserver
): Promise<WorkflowCommandExecution> {
  const projectCwd = options.cwd || process.cwd();
  const resolvedWorkflow = await getWorkflowDefinition(workflowId, projectCwd);
  const workflow = resolvedWorkflow?.workflow;

  if (!workflow) {
    const available = (await listWorkflowDefinitions(projectCwd)).map((preset) => preset.id).join(", ");
    throw new Error(
      `Unknown workflow: ${workflowId}\nAvailable workflows: ${available}`
    );
  }

  // Validate task
  if (!options.task) {
    throw new Error("Usage: /workflow run <id> --task 'your task'");
  }

  // Get effective settings
  const effectiveSettings = await getEffectiveWorkflowSettings(projectCwd);
  const sequential = options.sequential ?? true;

  // Determine working directory
  const workingDir = options.workingDir || projectCwd;

  // Create run directory with timestamp
  const runId = `run-${Date.now()}`;
  const runDir = path.join(workingDir, ".pi", "workflows", "runs", runId);

  // Determine runner type from settings and CLI options
  const runnerInfo = await determineRunner(
    options.runner,
    effectiveSettings,
    runDir,
    workingDir,
    options
  );

  // Print workflow start
  console.log("\n" + "═".repeat(60));
  console.log(`🚀 WORKFLOW: ${workflow.name}`);
  console.log("═".repeat(60));
  console.log(`📋 Task: ${options.task}`);
  console.log(`🔧 Runner: ${runnerInfo.name}`);
  console.log(`📊 Mode: ${sequential ? "sequential (maxParallelism=1)" : "workflow default"}`);
  console.log(`📁 Run ID: ${runId}`);
  console.log("");

  // Create orchestrator with progress callbacks
  const orchestrator = createOrchestrator(
    registry,
    runnerInfo.runner,
    (event) => {
      observer?.onProgress?.(event);
      switch (event.type) {
        case "workflow:start":
          console.log("▶ Starting workflow execution...\n");
          break;

        case "step:start":
          console.log(`  ┌─ ${event.stepTitle}`);
          console.log(`  │  Agent: ${event.agentName}`);
          console.log(`  │  Session: ${event.sessionId.slice(0, 12)}...`);
          break;

        case "step:running":
          break;

        case "step:pending":
          if (options.verbose) {
            console.log(`  ○ ${event.stepId} pending`);
          }
          break;

        case "step:approval-requested":
          console.log(`  ? Approval required for ${event.stepTitle} (${event.agentName})`);
          break;

        case "step:approval-resolved":
          console.log(`  ${event.approved ? "✓" : "✗"} Approval ${event.approved ? "granted" : "rejected"}${event.reason ? `: ${event.reason}` : ""}`);
          if (!event.approved) {
            console.log("");
          }
          break;

        case "step:complete":
          if (event.status === "succeeded") {
            console.log(`  └─ ✓ ${event.summary.slice(0, 60)}${event.summary.length > 60 ? "..." : ""}`);
          } else {
            const statusIcon =
              event.status === "cancelled" ? "⚠" :
              event.status === "timed_out" ? "⏱" : "✗";
            console.log(`  └─ ${statusIcon} ${event.summary || event.status}`);
          }
          console.log("");
          break;

        case "workflow:complete":
          break;

        case "workflow:error":
          console.error(`\n❌ Workflow error: ${event.error}`);
          break;

        case "workflow:cancelled":
          console.warn(`\n⚠ Workflow cancelled: ${event.reason}`);
          break;

        case "workflow:timeout":
          console.warn(`\n⏱ Workflow timed out after ${event.timeoutMs}ms`);
          break;
      }
    },
    {
      sequential,
      approvalHandler: observer?.onApprovalRequest,
    }
  );

  // Execute workflow
  const startTime = Date.now();
  let result: WorkflowRunResult;

  try {
    result = await orchestrator.execute(workflow, options.task);
  } finally {
    // No runner cleanup needed yet; keep block for future resource disposal.
  }

  const duration = Date.now() - startTime;

  // Print final result
  printWorkflowResult(result, duration);
  observer?.onResult?.(result, duration);

  // Persist run artifacts
  await persistRunArtifacts(runDir, runId, result, workflow, workingDir);
  await cleanupWorkflowArtifacts(result, workingDir);

  // Exit with error code if failed
  if (result.status === "failed" || result.status === "aborted" || result.status === "timed_out") {
    throw new Error(result.error || "Workflow execution failed");
  }

  return {
    workflowId,
    result,
    durationMs: duration,
  };
}

/**
 * Print workflow result to console.
 */
function printWorkflowResult(result: WorkflowRunResult, durationMs: number): void {
  console.log("═".repeat(60));
  console.log("📊 WORKFLOW RESULT");
  console.log("═".repeat(60));

  // Status
  const statusIcon =
    result.status === "succeeded" ? "✅" :
    result.status === "cancelled" ? "⚠" :
    result.status === "timed_out" ? "⏱" : "❌";
  const statusText =
    result.status === "succeeded" ? "SUCCEEDED" :
    result.status === "cancelled" ? "CANCELLED" :
    result.status === "timed_out" ? "TIMED OUT" :
    result.status === "failed" ? "FAILED" : result.status.toUpperCase();

  console.log(`${statusIcon} Status: ${statusText}`);
  console.log(`⏱ Duration: ${formatDuration(durationMs)}`);
  console.log(`🆔 Run ID: ${result.runId}`);
  console.log("");

  // Steps summary
  console.log("## Steps");
  console.log("");

  const steps = Object.values(result.stepResults).sort(
    (a, b) => new Date(a.startedAt).getTime() - new Date(b.startedAt).getTime()
  );

  for (const step of steps) {
    const stepStatusIcon =
      step.status === "succeeded" ? "✓" :
      step.status === "cancelled" ? "⚠" :
      step.status === "timed_out" ? "⏱" : "✗";
    const stepStatusText = step.status.charAt(0).toUpperCase() + step.status.slice(1).replace("_", " ");

    console.log(`  ${stepStatusIcon} ${step.stepTitle} (${stepStatusText})`);

    if ((step.status === "failed" || step.status === "timed_out" || step.status === "cancelled") && step.error) {
      console.log(`    └─ Error: ${step.error}`);
    }
  }

  console.log("");

  // Final output
  if (result.finalText) {
    console.log("## Final Output");
    console.log("");
    console.log(result.finalText);
    console.log("");
  }

  // Error
  if (result.error) {
    console.log("## Error");
    console.log("");
    console.log(result.error);
    console.log("");
  }

  // Summary
  if (result.summary) {
    console.log("## Summary");
    console.log("");
    console.log(result.summary);
    console.log("");
  }
}

/**
 * Format duration in milliseconds to human-readable string.
 */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  return `${minutes}m ${seconds}s`;
}

/**
 * Persist run artifacts to disk.
 */
async function persistRunArtifacts(
  runDir: string,
  runId: string,
  result: WorkflowRunResult,
  workflow: WorkflowSpec,
  workingDir: string
): Promise<void> {
  try {
    // Create run directory
    await fs.mkdir(runDir, { recursive: true });

    // Save workflow spec
    await fs.writeFile(
      path.join(runDir, "workflow.json"),
      JSON.stringify(workflow, null, 2)
    );

    // Save run metadata
    await fs.writeFile(
      path.join(runDir, "metadata.json"),
      JSON.stringify({
        runId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: result.status,
        startedAt: result.startedAt,
        finishedAt: result.finishedAt,
      }, null, 2)
    );

    // Save step results
    await fs.writeFile(
      path.join(runDir, "result.json"),
      JSON.stringify(result, null, 2)
    );

    // Save per-step results
    const stepsDir = path.join(runDir, "steps");
    await fs.mkdir(stepsDir, { recursive: true });

    for (const [stepId, stepResult] of Object.entries(result.stepResults)) {
      const stepDir = path.join(stepsDir, stepId);
      await fs.mkdir(stepDir, { recursive: true });

      await fs.writeFile(
        path.join(stepDir, "result.json"),
        JSON.stringify(stepResult, null, 2)
      );

      await persistStepLogs(stepDir, stepResult.sessionId, workingDir);
    }

    // Save final output separately
    if (result.finalText) {
      await fs.writeFile(
        path.join(runDir, "output.txt"),
        result.finalText
      );
    }

    // Save summary
    if (result.summary) {
      await fs.writeFile(
        path.join(runDir, "summary.txt"),
        result.summary
      );
    }

    console.log(`\n📁 Run artifacts saved to: ${runDir}`);
  } catch (error) {
    // Silently ignore persistence errors
    if (error instanceof Error) {
      console.warn(`\n⚠ Failed to save run artifacts: ${error.message}`);
    }
  }
}

async function persistStepLogs(
  stepDir: string,
  sessionId: string,
  workingDir: string
): Promise<void> {
  const sessionDir = path.join(
    workingDir,
    ".pi",
    "workflows",
    "sessions",
    sessionId
  );

  const logFiles = ["stdout.log", "stderr.log"];

  for (const logFile of logFiles) {
    const src = path.join(sessionDir, logFile);
    const dest = path.join(stepDir, logFile);

    try {
      await fs.copyFile(src, dest);
    } catch {
      // Some runners do not emit logs; skip missing files.
    }
  }
}

async function cleanupWorkflowArtifacts(
  result: WorkflowRunResult,
  workingDir: string
): Promise<void> {
  await cleanupSessionDirectories(result, workingDir);
  await pruneRunDirectories(workingDir);
}

export async function cleanupWorkflowStorage(
  target: WorkflowCleanupTarget,
  workingDir = process.cwd()
): Promise<string> {
  const cleaned: string[] = [];

  if (target === "sessions" || target === "all") {
    const sessionsDir = path.join(workingDir, ".pi", "workflows", "sessions");
    await fs.rm(sessionsDir, { recursive: true, force: true });
    cleaned.push("session scratch data");
  }

  if (target === "runs" || target === "all") {
    const runsDir = path.join(workingDir, ".pi", "workflows", "runs");
    await fs.rm(runsDir, { recursive: true, force: true });
    cleaned.push("run artifacts");
  }

  return cleaned.length > 0
    ? `Cleaned ${cleaned.join(" and ")} in ${path.join(workingDir, ".pi", "workflows")}`
    : "Nothing to clean.";
}

async function cleanupSessionDirectories(
  result: WorkflowRunResult,
  workingDir: string
): Promise<void> {
  const sessionRoot = path.join(workingDir, ".pi", "workflows", "sessions");
  const sessionIds = Array.from(
    new Set(
      Object.values(result.stepResults)
        .map((step) => step.sessionId)
        .filter((sessionId): sessionId is string => Boolean(sessionId))
    )
  );

  await Promise.allSettled(
    sessionIds.map(async (sessionId) => {
      const sessionDir = path.join(sessionRoot, sessionId);
      await fs.rm(sessionDir, { recursive: true, force: true });
    })
  );
}

async function pruneRunDirectories(workingDir: string): Promise<void> {
  const runsDir = path.join(workingDir, ".pi", "workflows", "runs");
  let entries: Array<{ name: string; path: string; mtimeMs: number }> = [];

  try {
    const dirEntries = await fs.readdir(runsDir, { withFileTypes: true });
    entries = await Promise.all(
      dirEntries
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const fullPath = path.join(runsDir, entry.name);
          const stat = await fs.stat(fullPath);
          return {
            name: entry.name,
            path: fullPath,
            mtimeMs: stat.mtimeMs,
          };
        })
    );
  } catch {
    return;
  }

  if (entries.length <= WORKFLOW_RUN_RETENTION_COUNT) {
    return;
  }

  const toDelete = entries
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(WORKFLOW_RUN_RETENTION_COUNT);

  await Promise.allSettled(
    toDelete.map((entry) => fs.rm(entry.path, { recursive: true, force: true }))
  );
}

/**
 * Parse CLI arguments for /workflow command.
 */
export function parseWorkflowCommandArgs(args: string[]): WorkflowCommandOptions {
  const options: WorkflowCommandOptions = { parseErrors: [] };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const readRequiredValue = (flag: string): string | undefined => {
      const value = args[i + 1];
      if (!value || value.startsWith("-")) {
        options.parseErrors?.push(`Missing value for ${flag}`);
        return undefined;
      }
      i++;
      return value;
    };

    switch (arg) {
      case "list":
        options.list = true;
        break;
      case "show":
        options.show = readRequiredValue("show <id>");
        break;
      case "settings":
        options.settings = true;
        break;
      case "cleanup": {
        const value = args[i + 1];
        if (value && !value.startsWith("-")) {
          if (value === "sessions" || value === "runs" || value === "all") {
            options.cleanup = value;
            i++;
          } else {
            options.parseErrors?.push(`Invalid cleanup target: ${value}. Expected sessions, runs, or all.`);
          }
        } else {
          options.cleanup = "all";
        }
        break;
      }
      case "add":
        options.add = readRequiredValue("add <id>");
        break;
      case "remove":
        options.remove = readRequiredValue("remove <id>");
        break;
      case "save":
        options.save = readRequiredValue("save <id>");
        break;
      case "run":
        options.run = readRequiredValue("run <id>");
        break;
      case "--list":
      case "-l":
        options.list = true;
        break;
      case "--show":
      case "-s":
        options.show = readRequiredValue("--show <id>");
        break;
      case "--task":
      case "-t":
        options.task = readRequiredValue("--task <text>");
        break;
      case "--as":
        options.saveAs = readRequiredValue("--as <id>");
        break;
      case "--scope": {
        const scope = readRequiredValue("--scope <project|user>");
        if (scope === "project" || scope === "user") {
          options.scope = scope;
        } else if (scope) {
          options.parseErrors?.push(`Invalid scope: ${scope}. Expected project or user.`);
        }
        break;
      }
      case "--runner": {
        const runner = readRequiredValue("--runner <local-process|default|zellij>");
        if (runner === "local-process" || runner === "default" || runner === "zellij") {
          options.runner = runner;
        } else if (runner) {
          options.parseErrors?.push(`Invalid runner: ${runner}. Expected local-process, default, or zellij.`);
        }
        break;
      }
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--sequential":
        options.sequential = true;
        break;
      case "--working-dir":
      case "-d":
        options.workingDir = args[++i] || undefined;
        break;
      case "--settings":
        options.settings = true;
        break;
      case "--cleanup":
        options.cleanup = "all";
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          if (!options.show && !options.run && !options.add && !options.remove && !options.save && !options.task) {
            options.task = arg;
          }
        }
    }
  }

  if (options.parseErrors?.length === 0) {
    delete options.parseErrors;
  }

  return options;
}

/**
 * Print help for /workflow command.
 */
function getHelpText(): string {
  return `
/workflow - Inspect and run workflows

Usage:
  /workflow [options]
  /workflow run <id> [options]
  /workflow add <id>
  /workflow remove <id>
  /workflow save <id> [options]
  /workflow cleanup [sessions|runs|all]

Interactive Menu:
  /workflow               Opens interactive menu for workflow management

Subcommands:
  run <id>                Run a workflow with the given ID
  add <id>                Add a workflow to project settings
  remove <id>             Remove a workflow from project settings
  save <id>               Save a workflow as a project or user template
  cleanup [target]        Remove workflow session scratch data, run artifacts, or both
  settings                Open workflow settings menu

Options:
  -l, --list              List configured workflows
  -s, --show <id>         Show details of a specific workflow
  -t, --task <text>       Task description for workflow execution
  --as <id>               Target id when saving a workflow template
  --scope <scope>         Save scope: project (default) or user
  --runner <type>         Runner type: local-process (default), default, or zellij
  --settings              Open workflow settings menu
  --cleanup               Clean both workflow sessions and run artifacts
  -v, --verbose           Verbose output
  --sequential            Explicitly request sequential execution (default)
  -d, --working-dir <dir> Working directory for run artifacts
  -h, --help              Show this help

Settings:
  Workflow settings are stored in .pi/agent/settings.json in the project
  directory (with fallback to ~/.pi/agent/settings.json).

  Supported settings:
    conductorWorkflow           Array of configured workflow IDs
    conductorWorkflowMultiplexer  "none" (default) or "zellij"
    conductorWorkflowDisplay      "main-window" or "split-pane" (zellij only)

Examples:
  # Add workflows to settings
  /workflow add plan-implement-review
  /workflow add quick-review

  # Save a workflow as a user template
  /workflow save plan-implement-review --as my-plan-review --scope user

  # List configured workflows
  /workflow --list

  # Open interactive menu
  /workflow

  # Open settings menu
  /workflow settings

  # Clean workflow scratch data and run history
  /workflow cleanup
  /workflow cleanup sessions
  /workflow cleanup runs

  # Show workflow details
  /workflow --show plan-implement-review

  # Run a workflow (uses settings to determine runner)
  /workflow run plan-implement-review --task 'Add user authentication'

  # Run with verbose output
  /workflow run implement-and-review -t 'Fix the login bug' --verbose

  # Run in Zellij mode explicitly
  /workflow run plan-implement-review -t 'Build feature' --runner zellij

  # Sequential execution is the default for /workflow run
  /workflow run plan-implement-review -t 'Build feature'

See Also:
  /team - Alternative workflow runner with auto-selection
  Zellij integration requires 'zellij' to be installed and in PATH.
`;
}
