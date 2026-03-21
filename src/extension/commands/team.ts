// src/extension/commands/team.ts - /team command implementation

import type { AgentRegistry } from "../../registry";
import type { WorkflowSpec } from "../../workflow/types";
import { listPresets, getPreset, WORKFLOW_PRESETS } from "../../workflow/presets";
import { createOrchestrator, formatWorkflowResult } from "../../runtime/orchestrator";
import { DefaultSessionRunner } from "../../runtime/childSessionRunner";

export interface TeamCommandOptions {
  /** Task description */
  task: string;
  /** Workflow ID (optional, defaults to first matching preset) */
  workflowId?: string;
  /** List available workflows */
  list?: boolean;
  /** Show a specific workflow */
  show?: string;
  /** Verbose output */
  verbose?: boolean;
  /** Show help */
  help?: boolean;
}

/**
 * Execute the /team command.
 */
export async function executeTeamCommand(
  options: TeamCommandOptions,
  registry: AgentRegistry
): Promise<void> {
  if (options.help) {
    console.log(getHelpText());
    return;
  }

  // Handle list option
  if (options.list) {
    listWorkflows();
    return;
  }

  // Handle show option
  if (options.show) {
    showWorkflow(options.show);
    return;
  }

  // Validate task
  if (!options.task) {
    throw new Error("Usage: /team --task 'your task' [--workflow-id <id>]");
  }

  // Determine workflow
  let workflow: WorkflowSpec | undefined;

  if (options.workflowId) {
    workflow = getPreset(options.workflowId);

    if (!workflow) {
      const available = listPresets().map((preset) => preset.id).join(", ");
      throw new Error(`Unknown workflow: ${options.workflowId}. Available workflows: ${available}`);
    }
  } else {
    // Auto-select based on task keywords
    workflow = selectWorkflowForTask(options.task);

    if (options.verbose) {
      console.log(`Selected workflow: ${workflow?.id} (${workflow?.name})`);
    }
  }

  // Execute workflow
  console.log(`\n🚀 Starting workflow: ${workflow!.name}`);
  console.log(`📋 Task: ${options.task}`);
  console.log("");

  const runner = new DefaultSessionRunner({
    onStatusChange: (stepId, status) => {
      if (status === "running") {
        process.stdout.write(`  ⏳ Running step...`);
      }
    },
  });

  const orchestrator = createOrchestrator(registry, runner, (event) => {
    switch (event.type) {
      case "workflow:start":
        break;
      case "step:start":
        console.log(`  ▶ ${event.stepTitle} (${event.agentName})`);
        break;
      case "step:complete":
        if (event.status === "succeeded") {
          console.log(`  ✓ ${event.summary.slice(0, 60)}${event.summary.length > 60 ? "..." : ""}`);
        } else {
          const statusIcon = event.status === "cancelled" ? "⚠" : 
                            event.status === "timed_out" ? "⏱" : "✗";
          console.log(`  ${statusIcon} ${event.summary}`);
        }
        break;
      case "workflow:complete":
        console.log("");
        break;
    }
  });

  const result = await orchestrator.execute(workflow!, options.task);

  // Print result
  console.log("\n" + "=".repeat(60));
  console.log(formatWorkflowResult(result));

  // Exit with error code if failed
  if (result.status === "failed") {
    throw new Error(result.error || "Workflow execution failed");
  }
}

/**
 * List available workflows.
 */
function listWorkflows(): void {
  const presets = listPresets();

  console.log("\nAvailable Workflows:\n");

  for (const preset of presets) {
    console.log(`  ${preset.id}`);
    console.log(`    ${preset.name}`);
    if (preset.description) {
      console.log(`    ${preset.description}`);
    }
    console.log("");
  }
}

/**
 * Show details of a specific workflow.
 */
function showWorkflow(workflowId: string): void {
  const workflow = getPreset(workflowId);

  if (!workflow) {
    throw new Error(`Unknown workflow: ${workflowId}`);
  }

  console.log(`\n# ${workflow.name}`);
  console.log(`ID: ${workflow.id}`);
  if (workflow.description) {
    console.log(`\n${workflow.description}`);
  }

  console.log("\n## Steps\n");

  for (const step of workflow.steps) {
    const target = getStepTargetDescription(step);
    console.log(`- **${step.title}**`);
    console.log(`  ID: ${step.id}`);
    console.log(`  Target: ${target}`);
    if (step.dependsOn && step.dependsOn.length > 0) {
      console.log(`  Depends on: ${step.dependsOn.join(", ")}`);
    }
    console.log(`  Prompt: ${step.prompt}`);
    console.log("");
  }

  console.log("## Policy\n");
  console.log(`- Max parallelism: ${workflow.policy?.maxParallelism || 1}`);
  console.log(`- On failure: ${workflow.policy?.onStepFailure || "abort"}`);

  console.log("\n## Synthesis\n");
  console.log(`- Strategy: ${workflow.synthesis?.strategy || "lead"}`);
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
 * Select an appropriate workflow based on task keywords.
 */
function selectWorkflowForTask(task: string): WorkflowSpec {
  const taskLower = task.toLowerCase();

  // Keywords mapping to workflows
  const keywordMap: Array<{ keywords: string[]; workflow: WorkflowSpec }> = [
    {
      keywords: ["review", "audit", "check", "assess"],
      workflow: WORKFLOW_PRESETS["parallel-audit"],
    },
    {
      keywords: ["implement", "build", "create", "add", "fix", "refactor"],
      workflow: WORKFLOW_PRESETS["implement-and-review"],
    },
    {
      keywords: ["plan", "design", "architecture", "approach"],
      workflow: WORKFLOW_PRESETS["plan-implement-review"],
    },
    {
      keywords: ["write", "document", "docs", "blog", "tutorial"],
      workflow: WORKFLOW_PRESETS["research-and-write"],
    },
    {
      keywords: ["quick", "simple", "fast"],
      workflow: WORKFLOW_PRESETS["quick-review"],
    },
  ];

  // Find first matching workflow
  for (const { keywords, workflow } of keywordMap) {
    if (keywords.some((kw) => taskLower.includes(kw))) {
      return workflow;
    }
  }

  // Default to implement-and-review
  return WORKFLOW_PRESETS["implement-and-review"];
}

/**
 * CLI parser for /team command.
 */
export function parseTeamCommandArgs(args: string[]): TeamCommandOptions {
  const options: TeamCommandOptions = {
    task: "",
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case "--task":
      case "-t":
        options.task = args[++i] || "";
        break;
      case "--workflow-id":
      case "-w":
        options.workflowId = args[++i] || undefined;
        break;
      case "--list":
      case "-l":
        options.list = true;
        break;
      case "--show":
      case "-s":
        options.show = args[++i] || undefined;
        break;
      case "--verbose":
      case "-v":
        options.verbose = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          // Positional argument - treat as task
          options.task = arg;
        }
    }
  }

  return options;
}

/**
 * Print help for /team command.
 */
function getHelpText(): string {
  return `
/team - Run multi-agent workflows

Usage:
  /team [options]

Options:
  -t, --task <text>        Task description (required unless --list or --show)
  -w, --workflow-id <id>    Specific workflow to use
  -l, --list               List available workflows
  -s, --show <id>          Show details of a specific workflow
  -v, --verbose            Verbose output
  -h, --help               Show this help

Examples:
  /team --list
  /team --show plan-implement-review
  /team --task 'Add user authentication' --workflow-id implement-and-review
  /team 'Fix the login bug'
`;
}
