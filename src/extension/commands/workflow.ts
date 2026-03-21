// src/extension/commands/workflow.ts - /workflow command implementation

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { listPresets, getPreset } from "../../workflow/presets";
import type { WorkflowSpec, WorkflowRunResult } from "../../workflow/types";
import type { AgentRegistry } from "../../registry";
import { createOrchestrator } from "../../runtime/orchestrator";
import type { ProgressEvent } from "../../runtime/orchestrator";
import {
  DefaultSessionRunner,
  LocalProcessRunner,
} from "../../runtime/childSessionRunner";

export interface WorkflowCommandOptions {
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
}

export interface WorkflowCommandObserver {
  onProgress?: (event: ProgressEvent) => void;
  onResult?: (result: WorkflowRunResult, durationMs: number) => void;
}

export interface WorkflowCommandExecution {
  workflowId: string;
  result: WorkflowRunResult;
  durationMs: number;
}

/**
 * Execute the /workflow command.
 */
export async function executeWorkflowCommand(
  options: WorkflowCommandOptions,
  registry?: AgentRegistry,
  observer?: WorkflowCommandObserver
): Promise<WorkflowCommandExecution | void> {
  if (options.help) {
    console.log(getHelpText());
    return;
  }

  if (options.settings) {
    await showWorkflowSettings();
    return;
  }

  if (options.add) {
    await addWorkflow(options.add);
    return;
  }

  if (options.remove) {
    await removeWorkflow(options.remove);
    return;
  }

  // Handle list option
  if (options.list) {
    await listConfiguredWorkflows();
    return;
  }

  // Handle show option
  if (options.show) {
    showWorkflow(options.show);
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

  return showWorkflowMenu(options, registry, observer);
}

/**
 * List configured workflows.
 */
async function listConfiguredWorkflows(): Promise<void> {
  const configured = await getConfiguredWorkflowIds();

  console.log("\nConfigured Workflows:\n");

  if (configured.length === 0) {
    console.log("  No workflows configured.");
    console.log("  Use '/workflow add <workflow-id>' to add one.");
    console.log("");
    return;
  }

  for (let i = 0; i < configured.length; i++) {
    const workflowId = configured[i];
    const preset = getPreset(workflowId);
    const label = i === 0 ? " (default)" : "";

    console.log(`  ${i + 1}. ${workflowId}${label}`);
    if (preset) {
      console.log(`     ${preset.name}`);
      if (preset.description) {
        console.log(`     ${preset.description}`);
      }
    } else {
      console.log("     Unknown workflow ID in settings");
    }
    console.log("");
  }
}

/**
 * Show the main workflow menu.
 */
async function showWorkflowMenu(
  options: WorkflowCommandOptions,
  registry: AgentRegistry,
  observer?: WorkflowCommandObserver
): Promise<WorkflowCommandExecution | void> {
  const rl = createInterface({ input, output });

  try {
    while (true) {
      console.log("\n╔════════════════════════════════════════╗");
      console.log("║           Workflow Menu                ║");
      console.log("╠════════════════════════════════════════╣");
      console.log("║  1. Run workflow                       ║");
      console.log("║  2. List workflows                    ║");
      console.log("║  3. Add workflow                       ║");
      console.log("║  4. Remove workflow                    ║");
      console.log("║  5. Settings                           ║");
      console.log("║  0. Exit                              ║");
      console.log("╚════════════════════════════════════════╝");
      console.log("");

      const choice = (await rl.question("Select option: ")).trim();

      switch (choice) {
        case "1":
          return promptAndRunWorkflow(options, registry, observer);
        case "2":
          await listConfiguredWorkflows();
          break;
        case "3":
          const addId = (await rl.question("Enter workflow ID to add: ")).trim();
          if (addId) {
            await addWorkflow(addId);
          }
          break;
        case "4":
          const removeId = (await rl.question("Enter workflow ID to remove: ")).trim();
          if (removeId) {
            await removeWorkflow(removeId);
          }
          break;
        case "5":
          await showWorkflowSettings();
          break;
        case "0":
        case "exit":
        case "q":
          console.log("Goodbye!");
          return;
        default:
          console.log("Invalid option. Please try again.");
      }
    }
  } finally {
    rl.close();
  }
}

/**
 * Show workflow settings menu.
 */
async function showWorkflowSettings(): Promise<void> {
  const rl = createInterface({ input, output });

  try {
    const context = await getWorkflowSettingsContext();
    const settings: EffectiveWorkflowSettings = { ...context.settings };
    let saveScope: SettingsScope = context.scope;

    while (true) {
      console.log("\n╔═══════════════════════════════════════════════╗");
      console.log("║              Workflow Settings               ║");
      console.log("╠═══════════════════════════════════════════════╣");
      console.log(`║  1. Multiplexer: ${padRight(settings.conductorWorkflowMultiplexer, 25)}║`);
      console.log(`║  2. Display:    ${padRight(settings.conductorWorkflowDisplay, 25)}║`);
      console.log(`║  3. Save scope: ${padRight(saveScope, 25)}║`);
      console.log("║  4. Configured workflows                    ║");
      console.log("║  5. Save & Exit                             ║");
      console.log("║  0. Cancel                                  ║");
      console.log("╚═══════════════════════════════════════════════╝");
      console.log("");

      const choice = (await rl.question("Select setting to modify: ")).trim();

      switch (choice) {
        case "1":
          settings.conductorWorkflowMultiplexer = await selectMultiplexer(rl);
          break;
        case "2":
          if (settings.conductorWorkflowMultiplexer === "none") {
            console.log("\n⚠ Display strategy only applies when multiplexer is 'zellij'.");
          } else {
            settings.conductorWorkflowDisplay = await selectDisplayStrategy(rl);
          }
          break;
        case "3":
          saveScope = await selectSettingsScope(rl, saveScope);
          break;
        case "4":
          await listConfiguredWorkflows();
          break;
        case "5":
          await saveWorkflowSettings(settings, saveScope);
          console.log("\n✓ Settings saved.");
          return;
        case "0":
        case "cancel":
        case "q":
          console.log("\nSettings discarded.");
          return;
        default:
          console.log("Invalid option. Please try again.");
      }
    }
  } finally {
    rl.close();
  }
}

function padRight(str: string, length: number): string {
  return str.padEnd(length);
}

async function selectMultiplexer(rl: ReturnType<typeof createInterface>): Promise<WorkflowMultiplexer> {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║         Select Multiplexer             ║");
  console.log("╠════════════════════════════════════════╣");
  console.log("║  1. none                                ║");
  console.log("║  2. zellij                               ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");

  while (true) {
    const choice = (await rl.question("Select multiplexer (1-2): ")).trim();
    switch (choice) {
      case "1":
      case "none":
        return "none";
      case "2":
      case "zellij":
        // Check if zellij is available
        const available = await isZellijAvailable();
        if (!available) {
          console.log("\n⚠ Zellij is not installed or not in PATH.");
          console.log("  Falling back to 'none'.");
          return "none";
        }
        return "zellij";
      default:
        console.log("Invalid choice. Please enter 1 or 2.");
    }
  }
}

async function selectDisplayStrategy(rl: ReturnType<typeof createInterface>): Promise<WorkflowDisplayStrategy> {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║       Select Display Strategy         ║");
  console.log("╠════════════════════════════════════════╣");
  console.log("║  1. main-window                        ║");
  console.log("║  2. split-pane                        ║");
  console.log("╚════════════════════════════════════════╝");
  console.log("");

  while (true) {
    const choice = (await rl.question("Select display strategy (1-2): ")).trim();
    switch (choice) {
      case "1":
      case "main-window":
        return "main-window";
      case "2":
      case "split-pane":
        return "split-pane";
      default:
        console.log("Invalid choice. Please enter 1 or 2.");
    }
  }
}

async function selectSettingsScope(
  rl: ReturnType<typeof createInterface>,
  currentScope: SettingsScope
): Promise<SettingsScope> {
  console.log("\n╔════════════════════════════════════════╗");
  console.log("║          Select Save Scope            ║");
  console.log("╠════════════════════════════════════════╣");
  console.log(`║  1. project${currentScope === "project" ? " (current)" : ""}${" ".repeat(currentScope === "project" ? 20 : 30)}║`);
  console.log(`║  2. user${currentScope === "user" ? " (current)" : ""}${" ".repeat(currentScope === "user" ? 23 : 33)}║`);
  console.log("╚════════════════════════════════════════╝");
  console.log("");

  while (true) {
    const choice = (await rl.question("Save to scope (1-2): ")).trim();
    switch (choice) {
      case "1":
      case "project":
        return "project";
      case "2":
      case "user":
        return "user";
      default:
        console.log("Invalid choice. Please enter 1 or 2.");
    }
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
function showWorkflow(workflowId: string): void {
  const workflow = getPreset(workflowId);

  if (!workflow) {
    console.error(`Unknown workflow: ${workflowId}`);
    console.log(`Run '/workflow --list' to see available workflows.`);
    return;
  }

  console.log(`\n# ${workflow.name}`);
  console.log(`**ID:** ${workflow.id}`);
  if (workflow.description) {
    console.log(`\n${workflow.description}`);
  }

  console.log("\n## Steps\n");

  for (const step of workflow.steps) {
    const target = getStepTargetDescription(step);
    console.log(`- **${step.title}**`);
    console.log(`  - ID: ${step.id}`);
    console.log(`  - Target: ${target}`);
    if (step.dependsOn && step.dependsOn.length > 0) {
      console.log(`  - Depends on: ${step.dependsOn.join(", ")}`);
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

async function promptAndRunWorkflow(
  options: WorkflowCommandOptions,
  registry: AgentRegistry,
  observer?: WorkflowCommandObserver
): Promise<WorkflowCommandExecution | void> {
  const configured = await getConfiguredWorkflowIds();

  if (configured.length === 0) {
    console.log("\nNo configured workflows found.");
    console.log("Use '/workflow add <workflow-id>' to add one.\n");
    return;
  }

  console.log("\nConfigured Workflows:\n");
  for (let i = 0; i < configured.length; i++) {
    const workflowId = configured[i];
    const preset = getPreset(workflowId);
    const label = i === 0 ? " (default)" : "";
    console.log(`  ${i + 1}. ${workflowId}${label}`);
    if (preset?.description) {
      console.log(`     ${preset.description}`);
    }
  }
  console.log("");

  const rl = createInterface({ input, output });

  try {
    const selection = (await rl.question("Select workflow by number or id: ")).trim();
    const selectionResult = resolveWorkflowSelection(selection, configured);
    const workflowId = selectionResult.workflowId;

    if (!workflowId) {
      const suggestionText = selectionResult.suggestions.length > 0
        ? ` Did you mean: ${selectionResult.suggestions.join(", ")}?`
        : "";
      throw new Error(`Invalid workflow selection.${suggestionText}`);
    }

    const task = options.task?.trim()
      ? options.task.trim()
      : (await rl.question(`Task for ${workflowId}: `)).trim();

    if (!task) {
      throw new Error("Task is required");
    }

    return runWorkflow(workflowId, { ...options, task }, registry, observer);
  } finally {
    rl.close();
  }
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

async function addWorkflow(workflowId: string): Promise<void> {
  const normalizedWorkflowId = resolveWorkflowIdForAdd(workflowId);
  const preset = normalizedWorkflowId ? getPreset(normalizedWorkflowId) : undefined;
  if (!preset) {
    const available = listPresets().map((entry) => entry.id).join(", ");
    throw new Error(`Unknown workflow: ${workflowId}. Available workflows: ${available}`);
  }

  const settings = await readWorkflowSettings();
  const configured = settings.conductorWorkflow ?? [];

  if (configured.includes(preset.id)) {
    console.log(`Workflow already configured: ${preset.id}`);
    return;
  }

  settings.conductorWorkflow = [...configured, preset.id];
  await writeWorkflowSettings(settings);

  console.log(`Added workflow: ${preset.id}`);
}

async function removeWorkflow(workflowId: string): Promise<void> {
  const normalizedWorkflowId = resolveWorkflowIdForAdd(workflowId);
  if (!normalizedWorkflowId) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }

  const settings = await readWorkflowSettings();
  const configured = settings.conductorWorkflow ?? [];

  if (!configured.includes(normalizedWorkflowId)) {
    console.log(`Workflow not configured: ${normalizedWorkflowId}`);
    return;
  }

  settings.conductorWorkflow = configured.filter((id) => id !== normalizedWorkflowId);
  await writeWorkflowSettings(settings);

  console.log(`Removed workflow: ${normalizedWorkflowId}`);
}

function resolveWorkflowIdForAdd(inputId: string): string | undefined {
  const presets = listPresets();
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

interface WorkflowSettings {
  conductorWorkflow?: string[];
  conductorWorkflowMultiplexer?: WorkflowMultiplexer;
  conductorWorkflowDisplay?: WorkflowDisplayStrategy;
}

type WorkflowMultiplexer = "none" | "zellij";
type WorkflowDisplayStrategy = "main-window" | "split-pane";
type SettingsScope = "project" | "user";

interface EffectiveWorkflowSettings {
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

async function getWorkflowSettingsContext(
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

async function writeWorkflowSettings(
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

async function getConfiguredWorkflowIds(): Promise<string[]> {
  const settings = await readWorkflowSettings();
  return settings.conductorWorkflow ?? [];
}

async function getConfiguredWorkflows(): Promise<Array<{ id: string; name: string; description?: string }>> {
  const ids = await getConfiguredWorkflowIds();
  return ids.map((id) => {
    const preset = getPreset(id);
    return {
      id,
      name: preset?.name ?? id,
      description: preset?.description,
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
  const workflow = getPreset(workflowId);

  if (!workflow) {
    const available = listPresets().map((preset) => preset.id).join(", ");
    throw new Error(
      `Unknown workflow: ${workflowId}\nAvailable workflows: ${available}`
    );
  }

  // Validate task
  if (!options.task) {
    throw new Error("Usage: /workflow run <id> --task 'your task'");
  }

  // Get effective settings
  const effectiveSettings = await getEffectiveWorkflowSettings();
  const sequential = options.sequential ?? true;

  // Determine working directory
  const workingDir = options.workingDir || process.cwd();

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
    { sequential }
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

/**
 * Parse CLI arguments for /workflow command.
 */
export function parseWorkflowCommandArgs(args: string[]): WorkflowCommandOptions {
  const options: WorkflowCommandOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "add":
        options.add = args[++i] || undefined;
        break;
      case "remove":
        options.remove = args[++i] || undefined;
        break;
      case "run":
        options.run = args[++i] || undefined;
        break;
      case "--list":
      case "-l":
        options.list = true;
        break;
      case "--show":
      case "-s":
        options.show = args[++i] || undefined;
        break;
      case "--task":
      case "-t":
        options.task = args[++i] || undefined;
        break;
      case "--runner":
        options.runner = (args[++i] || "local-process") as "local-process" | "default" | "zellij";
        break;
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
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          if (!options.show && !options.run && !options.add && !options.remove && !options.task) {
            options.task = arg;
          }
        }
    }
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

Interactive Menu:
  /workflow               Opens interactive menu for workflow management

Subcommands:
  run <id>                Run a workflow with the given ID
  add <id>                Add a workflow to project settings
  remove <id>             Remove a workflow from project settings
  settings                Open workflow settings menu

Options:
  -l, --list              List configured workflows
  -s, --show <id>         Show details of a specific workflow
  -t, --task <text>       Task description for workflow execution
  --runner <type>         Runner type: local-process (default), default, or zellij
  --settings              Open workflow settings menu
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

  # List configured workflows
  /workflow --list

  # Open interactive menu
  /workflow

  # Open settings menu
  /workflow settings

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
