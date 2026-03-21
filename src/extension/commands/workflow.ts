// src/extension/commands/workflow.ts - /workflow command implementation

import { listPresets, getPreset, WORKFLOW_PRESETS } from "../../workflow/presets";
import type { WorkflowSpec } from "../../workflow/types";

export interface WorkflowCommandOptions {
  /** List all workflows */
  list?: boolean;
  /** Show a specific workflow */
  show?: string;
  /** Filter workflows by keyword */
  filter?: string;
  /** Show help */
  help?: boolean;
}

/**
 * Execute the /workflow command.
 */
export async function executeWorkflowCommand(
  options: WorkflowCommandOptions
): Promise<void> {
  if (options.help) {
    console.log(getHelpText());
    return;
  }

  // Handle list option
  if (options.list) {
    listWorkflows(options.filter);
    return;
  }

  // Handle show option
  if (options.show) {
    showWorkflow(options.show);
    return;
  }

  // Default: list all workflows
  listWorkflows();
}

/**
 * List available workflows with optional filtering.
 */
function listWorkflows(filter?: string): void {
  const presets = listPresets();

  console.log("\nAvailable Workflows:\n");

  const filtered = filter
    ? presets.filter(
        (p) =>
          p.id.includes(filter!) ||
          p.name.toLowerCase().includes(filter!.toLowerCase()) ||
          p.description?.toLowerCase().includes(filter!.toLowerCase())
      )
    : presets;

  if (filtered.length === 0) {
    console.log(`  No workflows found${filter ? ` matching "${filter}"` : ""}.`);
    console.log("");
    return;
  }

  for (const preset of filtered) {
    console.log(`  ${preset.id}`);
    console.log(`    ${preset.name}`);
    if (preset.description) {
      console.log(`    ${preset.description}`);
    }
    console.log("");
  }

  console.log(`Total: ${filtered.length} workflow(s)\n`);
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

/**
 * Parse CLI arguments for /workflow command.
 */
export function parseWorkflowCommandArgs(args: string[]): WorkflowCommandOptions {
  const options: WorkflowCommandOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--list":
      case "-l":
        options.list = true;
        break;
      case "--show":
      case "-s":
        options.show = args[++i] || undefined;
        break;
      case "--filter":
      case "-f":
        options.filter = args[++i] || undefined;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          // Positional argument - treat as filter or workflow id
          if (!options.filter && !options.show) {
            // Check if it looks like a workflow id
            const preset = getPreset(arg);
            if (preset) {
              options.show = arg;
            } else {
              options.filter = arg;
            }
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
/workflow - Inspect and manage workflows

Usage:
  /workflow [options]

Options:
  -l, --list              List all available workflows
  -s, --show <id>         Show details of a specific workflow
  -f, --filter <keyword>  Filter workflows by keyword
  -h, --help              Show this help

Examples:
  /workflow --list
  /workflow -l
  /workflow --show plan-implement-review
  /workflow -s parallel-audit
  /workflow --filter review
  /workflow audit

See Also:
  /team - Run a workflow
`;
}
