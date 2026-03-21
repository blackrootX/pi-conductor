// src/runtime/childSessionRunner.ts - Run steps in isolated child sessions

import type { AgentSpec } from "../types";
import type { ResolvedWorkflowStep, StepResultEnvelope, StepArtifact, StepStatus } from "../workflow/types";
import type { ChildSessionContext } from "./contextBuilder";
import { buildChildSessionContext } from "./contextBuilder";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface ChildSessionOptions {
  /** Timeout for each step in milliseconds */
  timeout?: number;
  /** Callback when step status changes */
  onStatusChange?: (stepId: string, status: StepStatus) => void;
  /** Working directory for child sessions */
  workingDir?: string;
  /** Write step results to disk */
  writeResultsToDisk?: boolean;
}

export interface SessionRunner {
  runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[],
    sessionId?: string
  ): Promise<StepResultEnvelope>;

  /** Cancel a running step by session ID */
  cancelStep?(sessionId: string): Promise<void>;
}

/**
 * Result from executing a step in a child process.
 */
export interface ChildProcessResult {
  sessionId: string;
  status: "succeeded" | "failed" | "cancelled" | "timed_out";
  summary: string;
  artifact: StepArtifact;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
}

/**
 * Default session runner that executes steps.
 * This is a stub implementation - the actual execution depends on
 * the specific runtime environment (pi CLI, etc.)
 */
export class DefaultSessionRunner implements SessionRunner {
  private options: ChildSessionOptions;
  private runningSessions: Map<string, AbortController>;

  constructor(options: ChildSessionOptions = {}) {
    this.options = options;
    this.runningSessions = new Map();
  }

  async runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[],
    sessionId?: string
  ): Promise<StepResultEnvelope> {
    const startedAt = new Date().toISOString();
    const resolvedSessionId = sessionId ?? generateSessionId();

    // Build context
    const context = buildChildSessionContext(step, userTask, dependencyResults, allSteps);

    // Notify running
    this.options.onStatusChange?.(step.id, "running");

    // Create abort controller for cancellation/timeout
    const abortController = new AbortController();
    this.runningSessions.set(resolvedSessionId, abortController);

    try {
      // Execute the step with timeout support
      const result = await this.executeWithTimeout(
        () => this.executeStep(context, step.agent),
        abortController.signal
      );

      // Write result to disk if enabled
      if (this.options.writeResultsToDisk) {
        await this.writeResultToDisk(resolvedSessionId, {
          stepId: step.id,
          stepTitle: step.title,
          status: result.status,
          summary: result.summary,
          artifact: result.artifact,
          startedAt,
          finishedAt: new Date().toISOString(),
        });
      }

      return {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId: resolvedSessionId,
        status: result.status,
        summary: result.summary,
        artifact: result.artifact,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: result.error,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes("timeout") || errorMessage.includes("timed out");

      return {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId: resolvedSessionId,
        status: isTimeout ? "timed_out" : "failed",
        summary: "",
        artifact: { type: "text", value: "" },
        startedAt,
        finishedAt: new Date().toISOString(),
        error: errorMessage,
      };
    } finally {
      this.runningSessions.delete(resolvedSessionId);
    }
  }

  /**
   * Cancel a running step.
   */
  async cancelStep(sessionId: string): Promise<void> {
    const controller = this.runningSessions.get(sessionId);
    if (controller) {
      controller.abort();
      this.runningSessions.delete(sessionId);
    }
  }

  /**
   * Execute with timeout and cancellation support.
   */
  private async executeWithTimeout<T>(
    fn: () => Promise<T>,
    signal: AbortSignal
  ): Promise<T> {
    const timeout = this.options.timeout;

    if (!timeout) {
      return fn();
    }

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new Error(`Step execution timed out after ${timeout}ms`));
      }, timeout);

      signal.addEventListener("abort", () => {
        clearTimeout(timeoutId);
        reject(new Error("Step execution cancelled"));
      });

      fn()
        .then((result) => {
          clearTimeout(timeoutId);
          resolve(result);
        })
        .catch((error) => {
          clearTimeout(timeoutId);
          reject(error);
        });
    });
  }

  /**
   * Write step result to disk for observability.
   */
  private async writeResultToDisk(
    sessionId: string,
    result: Partial<StepResultEnvelope>
  ): Promise<void> {
    if (!this.options.workingDir) return;

    const resultsDir = path.join(this.options.workingDir, ".pi", "workflows", "results");
    const stepDir = path.join(resultsDir, sessionId);

    try {
      await fs.mkdir(stepDir, { recursive: true });
      await fs.writeFile(
        path.join(stepDir, "result.json"),
        JSON.stringify(result, null, 2)
      );
    } catch {
      // Silently ignore disk write errors
    }
  }

  /**
   * Execute a step. Override this in subclasses for custom execution.
   */
  protected async executeStep(
    context: ChildSessionContext,
    agent: AgentSpec
  ): Promise<{ status: StepStatus; summary: string; artifact: StepArtifact; error?: string }> {
    // Stub implementation - in a real system, this would:
    // 1. Spawn a child process or API call
    // 2. Inject the context as prompts
    // 3. Execute the agent
    // 4. Collect the result

    // For now, return a mock result
    return {
      status: "succeeded",
      summary: `Executed ${context.stepTitle} with ${context.agentName}. Processed ${context.dependencyOutputs.length} dependency outputs.`,
      artifact: {
        type: "text",
        value: JSON.stringify({
          step: context.stepTitle,
          agent: context.agentName,
          task: context.userTask,
          dependencies: context.dependencyOutputs.map((d) => d.stepId),
        }),
      },
    };
  }
}

/**
 * Local process session runner that spawns actual child processes.
 * This is the backend abstraction for executing steps.
 */
export class LocalProcessRunner implements SessionRunner {
  private options: ChildSessionOptions;
  private runningProcesses: Map<string, { pid: number; controller: AbortController }>;

  constructor(options: ChildSessionOptions = {}) {
    this.options = options;
    this.runningProcesses = new Map();
  }

  async runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[],
    sessionId?: string
  ): Promise<StepResultEnvelope> {
    const startedAt = new Date().toISOString();
    const resolvedSessionId = sessionId ?? generateSessionId();

    // Build context
    const context = buildChildSessionContext(step, userTask, dependencyResults, allSteps);

    // Notify running
    this.options.onStatusChange?.(step.id, "running");

    // Create abort controller
    const abortController = new AbortController();
    this.runningProcesses.set(resolvedSessionId, { pid: 0, controller: abortController });

    try {
      // Execute using child process
      const result = await this.spawnAndWait(resolvedSessionId, context, step, abortController);

      return {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId: resolvedSessionId,
        status: result.status,
        summary: result.summary,
        artifact: result.artifact,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: result.error,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const isTimeout = errorMessage.includes("timeout") || errorMessage.includes("timed out");
      const isCancelled = errorMessage.includes("cancelled") || errorMessage.includes("abort");

      return {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId: resolvedSessionId,
        status: isTimeout ? "timed_out" : isCancelled ? "cancelled" : "failed",
        summary: "",
        artifact: { type: "text", value: "" },
        startedAt,
        finishedAt: new Date().toISOString(),
        error: errorMessage,
      };
    } finally {
      this.runningProcesses.delete(resolvedSessionId);
    }
  }

  /**
   * Cancel a running step.
   */
  async cancelStep(sessionId: string): Promise<void> {
    const process = this.runningProcesses.get(sessionId);
    if (process) {
      process.controller.abort();
      // In a real implementation, we'd also kill the process
      this.runningProcesses.delete(sessionId);
    }
  }

  /**
   * Spawn a child process and wait for completion.
   */
  private async spawnAndWait(
    sessionId: string,
    context: ChildSessionContext,
    step: ResolvedWorkflowStep,
    abortController: AbortController
  ): Promise<{ status: StepStatus; summary: string; artifact: StepArtifact; error?: string }> {
    const timeout = this.options.timeout ?? 300000; // 5 minute default timeout
    const signal = abortController.signal;

    // Create a working directory for this session
    const sessionDir = this.options.workingDir
      ? path.join(this.options.workingDir, ".pi", "workflows", "sessions", sessionId)
      : path.join(process.cwd(), ".pi", "workflows", "sessions", sessionId);

    // Ensure session directory exists
    await fs.mkdir(sessionDir, { recursive: true });

    // Write context files for the child process
    const systemPromptPath = path.join(sessionDir, "system.md");
    const taskPromptPath = path.join(sessionDir, "task.md");
    const resultPath = path.join(sessionDir, "result.json");

    await fs.writeFile(systemPromptPath, context.systemPrompt, "utf8");
    await fs.writeFile(taskPromptPath, context.taskPrompt, "utf8");

    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let killed = false;

      // Find the pi CLI executable
      const piCliPath = findPiCli();

      const child = spawn(piCliPath, [
        "run",
        "--agent", step.agent.id,
        "--system-prompt", systemPromptPath,
        "--task", taskPromptPath,
        "--output", resultPath,
        "--session-id", sessionId,
      ], {
        cwd: sessionDir,
        signal: signal,
        env: {
          ...process.env,
          PI_WORKFLOW_SESSION_ID: sessionId,
          PI_WORKFLOW_STEP_ID: step.id,
          PI_WORKFLOW_STEP_TITLE: step.title,
        },
      });

      // Update PID in running processes
      const processInfo = this.runningProcesses.get(sessionId);
      if (processInfo) {
        processInfo.pid = child.pid!;
      }

      child.stdout?.on("data", (data) => {
        stdout += data.toString();
      });

      child.stderr?.on("data", (data) => {
        stderr += data.toString();
      });

      // Set up timeout
      const timeoutId = setTimeout(() => {
        killed = true;
        child.kill("SIGTERM");
      }, timeout);

      // Handle abort signal
      const abortHandler = () => {
        if (!killed) {
          killed = true;
          child.kill("SIGTERM");
        }
      };
      signal.addEventListener("abort", abortHandler);

      child.on("close", async (code) => {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);

        // Check for cancellation
        if (signal.aborted && !killed) {
          killed = true;
        }

        if (killed && signal.aborted) {
          resolve({
            status: "cancelled",
            summary: "",
            artifact: { type: "text", value: "" },
            error: "Step execution was cancelled",
          });
          return;
        }

        if (killed) {
          resolve({
            status: "timed_out",
            summary: "",
            artifact: { type: "text", value: "" },
            error: `Step execution timed out after ${timeout}ms`,
          });
          return;
        }

        // Try to read structured result
        let summary = "";
        let artifactValue = "";
        let artifactType: "text" | "json" = "text";

        try {
          const resultContent = await fs.readFile(resultPath, "utf8");
          const resultData = JSON.parse(resultContent);
          summary = resultData.summary || "";
          artifactValue = resultData.artifact || resultData.result || "";
          if (resultData.artifactType === "json") {
            artifactType = "json";
          }
        } catch {
          // No structured result, fall back to stdout
          summary = extractSummary(stdout) || `Executed ${context.stepTitle}`;
          artifactValue = stdout;
        }

        if (code === 0) {
          resolve({
            status: "succeeded",
            summary: summary || `Completed ${context.stepTitle}`,
            artifact: { type: artifactType, value: artifactValue },
          });
        } else {
          resolve({
            status: "failed",
            summary: summary || `Step failed with exit code ${code}`,
            artifact: { type: "text", value: stdout },
            error: stderr || `Exit code: ${code}`,
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeoutId);
        signal.removeEventListener("abort", abortHandler);

        resolve({
          status: "failed",
          summary: "",
          artifact: { type: "text", value: "" },
          error: `Failed to spawn child process: ${err.message}`,
        });
      });
    });
  }
}

/**
 * Mock session runner for testing - returns predefined results.
 */
export class MockSessionRunner implements SessionRunner {
  private mockResults: Map<string, StepResultEnvelope>;
  private delayMs: number;

  constructor(mockResults?: Map<string, StepResultEnvelope>, delayMs = 0) {
    this.mockResults = mockResults || new Map();
    this.delayMs = delayMs;
  }

  async runStep(
    step: ResolvedWorkflowStep,
    userTask: string,
    dependencyResults: Record<string, StepResultEnvelope>,
    allSteps: ResolvedWorkflowStep[],
    sessionId?: string
  ): Promise<StepResultEnvelope> {
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }

    const context = buildChildSessionContext(step, userTask, dependencyResults, allSteps);
    const resolvedSessionId = sessionId ?? generateSessionId();
    const startedAt = new Date().toISOString();

    // Check for predefined result
    const predefined = this.mockResults.get(step.id);
    if (predefined) {
      return {
        ...predefined,
        sessionId: resolvedSessionId,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    // Generate mock result
    return {
      stepId: step.id,
      stepTitle: step.title,
      agentId: step.agent.id,
      agentName: step.agent.name,
      sessionId: resolvedSessionId,
      status: "succeeded",
      summary: `Mock result for ${context.stepTitle}`,
      artifact: {
        type: "text",
        value: `Mock artifact from ${context.agentName}`,
      },
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

/**
 * Generate a unique session ID.
 */
export function generateSessionId(): string {
  return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Check if a step can run (all dependencies complete).
 */
export function canStepRun(
  step: ResolvedWorkflowStep,
  results: Record<string, StepResultEnvelope>
): boolean {
  if (!step.dependsOn || step.dependsOn.length === 0) {
    return true;
  }

  return step.dependsOn.every((depId) => {
    const result = results[depId];
    return result && result.status === "succeeded";
  });
}

/**
 * Check if a step should continue based on failure policy.
 */
export function shouldContinueOnFailure(
  step: ResolvedWorkflowStep,
  failedStepId: string,
  onStepFailure: "abort" | "continue"
): boolean {
  // If the failed step is a dependency of this step, abort
  if (step.dependsOn?.includes(failedStepId)) {
    return false;
  }

  // Otherwise, respect the policy
  return onStepFailure === "continue";
}

/**
 * Find the pi CLI executable path.
 */
function findPiCli(): string {
  // Check common locations
  const possiblePaths = [
    // User's global npm/bin
    path.join(process.env.HOME || "", ".npm-global", "bin", "pi"),
    path.join(process.env.HOME || "", ".local", "bin", "pi"),
    // npx
    "npx",
    // Direct installation
    "pi",
    // Current node_modules
    path.join(__dirname, "..", "..", "node_modules", ".bin", "pi"),
  ];

  // Check if we can use npx
  if (process.env.PATH) {
    const pathEnv = process.env.PATH.split(path.delimiter);
    for (const dir of pathEnv) {
      const piPath = path.join(dir, "pi");
      possiblePaths.push(piPath);
    }
  }

  // Return npx as fallback (it will resolve the package)
  return "npx";
}

/**
 * Extract a summary from stdout output.
 * Looks for markdown-style summary sections.
 */
function extractSummary(stdout: string): string | null {
  if (!stdout) return null;

  // Look for summary section in markdown
  const summaryMatch = stdout.match(/###\s*Summary\s*\n([\s\S]*?)(?=\n###|\n##|\n#|$)/i);
  if (summaryMatch && summaryMatch[1]) {
    return summaryMatch[1].trim().slice(0, 500);
  }

  // Look for result section
  const resultMatch = stdout.match(/###\s*Result\s*\n([\s\S]*?)(?=\n###|\n##|\n#|$)/i);
  if (resultMatch && resultMatch[1]) {
    return resultMatch[1].trim().slice(0, 500);
  }

  // Fall back to first non-empty line
  const lines = stdout.split("\n").filter((line) => line.trim());
  if (lines.length > 0) {
    return lines[0].trim().slice(0, 500);
  }

  return null;
}
