// src/extension/commands/workflow.ts - /workflow command implementation

import { promises as fs } from "node:fs";
import path from "node:path";
import { listPresets, getPreset } from "../../workflow/presets";
import type { WorkflowSpec, WorkflowRunResult } from "../../workflow/types";
import type { AgentRegistry } from "../../registry";
import { createOrchestrator } from "../../runtime/orchestrator";
import {
  DefaultSessionRunner,
  LocalProcessRunner,
} from "../../runtime/childSessionRunner";

export interface WorkflowCommandOptions {
  /** List all workflows */
  list?: boolean;
  /** Show a specific workflow */
  show?: string;
  /** Filter workflows by keyword */
  filter?: string;
  /** Show help */
  help?: boolean;
  /** Run a workflow */
  run?: string;
  /** Task description */
  task?: string;
  /** Runner type */
  runner?: "local-process" | "default";
  /** Verbose output */
  verbose?: boolean;
  /** Working directory for run artifacts */
  workingDir?: string;
  /** Force sequential execution (maxParallelism=1) */
  sequential?: boolean;
}

/**
 * Execute the /workflow command.
 */
export async function executeWorkflowCommand(
  options: WorkflowCommandOptions,
  registry?: AgentRegistry
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

  // Handle run option
  if (options.run) {
    if (!registry) {
      throw new Error("Agent registry is required to run workflows");
    }
    await runWorkflow(options.run, options, registry);
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

// ============================================================================
// Workflow Execution
// ============================================================================

/**
 * Run a workflow with the given ID.
 */
async function runWorkflow(
  workflowId: string,
  options: WorkflowCommandOptions,
  registry: AgentRegistry
): Promise<void> {
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

  // Determine runner type
  const useLocalProcess = options.runner === "local-process" || !options.runner;
  const sequential = options.sequential ?? true;

  // Determine working directory
  const workingDir = options.workingDir || process.cwd();

  // Create run directory with timestamp
  const runId = `run-${Date.now()}`;
  const runDir = path.join(workingDir, ".pi", "workflows", "runs", runId);

  // Print workflow start
  console.log("\n" + "═".repeat(60));
  console.log(`🚀 WORKFLOW: ${workflow.name}`);
  console.log("═".repeat(60));
  console.log(`📋 Task: ${options.task}`);
  console.log(`🔧 Runner: ${useLocalProcess ? "local-process" : "default"}`);
  console.log(`📊 Mode: ${sequential ? "sequential (maxParallelism=1)" : "workflow default"}`);
  console.log(`📁 Run ID: ${runId}`);
  console.log("");

  // Create runner
  const runner = useLocalProcess
    ? new LocalProcessRunner({
        workingDir,
        onStatusChange: (stepId, status) => {
          if (options.verbose) {
            console.log(`  [${status}] ${stepId}`);
          }
        },
      })
    : new DefaultSessionRunner({
        workingDir,
        writeResultsToDisk: true,
        onStatusChange: (stepId, status) => {
          if (options.verbose) {
            console.log(`  [${status}] ${stepId}`);
          }
        },
      });

  // Create orchestrator with progress callbacks
  const orchestrator = createOrchestrator(
    registry,
    runner,
    (event) => {
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

  // Persist run artifacts
  await persistRunArtifacts(runDir, runId, result, workflow, workingDir);

  // Exit with error code if failed
  if (result.status === "failed" || result.status === "aborted" || result.status === "timed_out") {
    throw new Error(result.error || "Workflow execution failed");
  }
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
      case "--filter":
      case "-f":
        options.filter = args[++i] || undefined;
        break;
      case "--task":
      case "-t":
        options.task = args[++i] || undefined;
        break;
      case "--runner":
        options.runner = (args[++i] || "local-process") as "local-process" | "default";
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
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        if (!arg.startsWith("-")) {
          // Positional argument - treat as filter or workflow id
          if (!options.filter && !options.show && !options.run) {
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
/workflow - Inspect and run workflows

Usage:
  /workflow [options]
  /workflow run <id> [options]

Subcommands:
  run <id>                Run a workflow with the given ID

Options:
  -l, --list              List all available workflows
  -s, --show <id>         Show details of a specific workflow
  -f, --filter <keyword>  Filter workflows by keyword
  -t, --task <text>       Task description for workflow execution
  --runner <type>         Runner type: local-process (default) or default
  -v, --verbose           Verbose output
  --sequential            Explicitly request sequential execution (default)
  -d, --working-dir <dir> Working directory for run artifacts
  -h, --help              Show this help

Examples:
  # List all workflows
  /workflow --list

  # Show workflow details
  /workflow --show plan-implement-review

  # Run a workflow
  /workflow run plan-implement-review --task 'Add user authentication'

  # Run with verbose output
  /workflow run implement-and-review -t 'Fix the login bug' --verbose

  # Sequential execution is the default for /workflow run
  /workflow run plan-implement-review -t 'Build feature'

See Also:
  /team - Alternative workflow runner with auto-selection
`;
}
