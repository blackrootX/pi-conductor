// src/runtime/zellijRunner.ts - Zellij-based workflow execution

import { execSync, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import type { AgentSpec } from "../types";
import type { ResolvedWorkflowStep, StepResultEnvelope, StepArtifact, StepStatus } from "../workflow/types";
import type { SessionRunner } from "./childSessionRunner";
import { buildChildSessionContext } from "./contextBuilder";

export interface ZellijRunnerOptions {
  /** Timeout for each step in milliseconds */
  timeout?: number;
  /** Callback when step status changes */
  onStatusChange?: (stepId: string, status: StepStatus) => void;
  /** Working directory for child sessions */
  workingDir?: string;
  /** Display strategy: main-window or split-pane */
  displayStrategy?: "main-window" | "split-pane";
  /** Whether we're already inside a Zellij session */
  inZellijSession?: boolean;
  /** Zellij session name (if provided) */
  sessionName?: string;
}

interface ZellijSession {
  name: string;
  paneId?: string;
  attached: boolean;
}

/**
 * Runner that executes workflow steps inside Zellij sessions/panes.
 */
export class ZellijRunner implements SessionRunner {
  private options: ZellijRunnerOptions;
  private currentSession: ZellijSession | null = null;
  private runningSessions: Map<string, AbortController>;
  private attachInstructionsShown = false;

  constructor(options: ZellijRunnerOptions = {}) {
    this.options = {
      timeout: 300000, // 5 minute default timeout
      displayStrategy: "main-window",
      inZellijSession: false,
      ...options,
    };
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
    const resolvedSessionId = sessionId ?? this.generateSessionId();

    // Build context
    const context = buildChildSessionContext(step, userTask, dependencyResults, allSteps);

    // Notify running
    this.options.onStatusChange?.(step.id, "running");

    // Create abort controller for cancellation/timeout
    const abortController = new AbortController();
    this.runningSessions.set(resolvedSessionId, abortController);

    try {
      // Execute step in Zellij
      const result = await this.executeInZellij(
        resolvedSessionId,
        context,
        step,
        abortController.signal
      );

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
   * Execute a step inside Zellij.
   */
  private async executeInZellij(
    sessionId: string,
    context: {
      systemPrompt: string;
      taskPrompt: string;
      stepTitle: string;
      agentName: string;
    },
    step: ResolvedWorkflowStep,
    signal: AbortSignal
  ): Promise<{ status: StepStatus; summary: string; artifact: StepArtifact; error?: string }> {
    const timeout = this.options.timeout ?? 300000;
    const workingDir = this.options.workingDir || process.cwd();

    // Create session directory
    const sessionDir = path.join(workingDir, ".pi", "workflows", "sessions", sessionId);
    await fs.mkdir(sessionDir, { recursive: true });

    // Write context files
    const systemPromptPath = path.join(sessionDir, "system.md");
    const taskPromptPath = path.join(sessionDir, "task.md");
    const resultPath = path.join(sessionDir, "result.json");

    await fs.writeFile(systemPromptPath, context.systemPrompt, "utf8");
    await fs.writeFile(taskPromptPath, context.taskPrompt, "utf8");

    // Get or create Zellij session
    const zellijSession = await this.getOrCreateSession(sessionId, step);

    if (!this.options.inZellijSession && !this.attachInstructionsShown) {
      this.attachInstructionsShown = true;
      if (this.options.displayStrategy === "split-pane") {
        console.log("\nℹ Split-pane mode requires an active Zellij session.");
        console.log("  Falling back to a detached workflow session you can attach to.");
      } else {
        console.log("\nℹ Main-window mode was requested outside Zellij.");
        console.log("  Starting a detached workflow session that you can attach to.");
      }
      console.log(`📎 Zellij session: ${zellijSession.name}`);
      console.log(`   Attach with: zellij attach ${zellijSession.name}\n`);
    }

    return new Promise((resolve) => {
      let killed = false;
      let stdout = "";
      let stderr = "";

      // Build the pi command
      const piCliPath = this.findPiCli();
      const commandArgs = [
        "run",
        "--agent", step.agent.id,
        "--system-prompt", systemPromptPath,
        "--task", taskPromptPath,
        "--output", resultPath,
        "--session-id", sessionId,
      ];

      if (step.agent.model) {
        commandArgs.push("--model", step.agent.model);
      }

      // If inside Zellij, send command to existing pane
      // If outside, spawn a new zellij session
      let child: ReturnType<typeof spawn>;

      if (this.options.inZellijSession && zellijSession.paneId) {
        // Inside Zellij: use zellij action to send command to pane
        // We need to create a new pane for this step
        const zellijCmd = [
          "action",
          "create-pane",
          "--direction", this.options.displayStrategy === "split-pane" ? "right" : "down",
          "--command", `${piCliPath} ${commandArgs.join(" ")}`,
        ];

        try {
          execSync(`zellij ${zellijCmd.join(" ")}`, {
            cwd: sessionDir,
            env: {
              ...process.env,
              ZELLIJ: "true",
            },
            stdio: "pipe",
          });
        } catch {
          // If zellij action fails, fall back to spawning directly
        }

        // Spawn process directly as fallback
        child = spawn(piCliPath, commandArgs, {
          cwd: sessionDir,
          env: {
            ...process.env,
            PI_WORKFLOW_SESSION_ID: sessionId,
            PI_WORKFLOW_STEP_ID: step.id,
            PI_WORKFLOW_STEP_TITLE: step.title,
            ...(step.agent.model ? { PI_WORKFLOW_AGENT_MODEL: step.agent.model } : {}),
          },
        });
      } else {
        // Outside Zellij: both display strategies fall back to a detached session.
        child = spawn("zellij", [
          "run",
          "--session-name", zellijSession.name,
          "--",
          piCliPath,
          ...commandArgs,
        ], {
          cwd: sessionDir,
          env: {
            ...process.env,
            PI_WORKFLOW_SESSION_ID: sessionId,
            PI_WORKFLOW_STEP_ID: step.id,
            PI_WORKFLOW_STEP_TITLE: step.title,
            ...(step.agent.model ? { PI_WORKFLOW_AGENT_MODEL: step.agent.model } : {}),
          },
        });
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

        await Promise.allSettled([
          fs.writeFile(path.join(sessionDir, "stdout.log"), stdout, "utf8"),
          fs.writeFile(path.join(sessionDir, "stderr.log"), stderr, "utf8"),
        ]);

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
          summary = this.extractSummary(stdout) || `Executed ${context.stepTitle}`;
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
          error: `Failed to spawn process: ${err.message}`,
        });
      });
    });
  }

  /**
   * Get or create a Zellij session for workflow execution.
   */
  private async getOrCreateSession(sessionId: string, step: ResolvedWorkflowStep): Promise<ZellijSession> {
    if (this.currentSession) {
      return this.currentSession;
    }

    const workingDir = this.options.workingDir || process.cwd();
    const sessionName = this.options.sessionName || `pi-workflow-${sessionId.slice(0, 8)}`;

    try {
      // Try to attach to existing session first
      const listOutput = execSync("zellij list-sessions 2>/dev/null || true", {
        encoding: "utf8",
        stdio: "pipe",
      });

      if (listOutput.includes(sessionName)) {
        // Session exists
        this.currentSession = {
          name: sessionName,
          attached: true,
        };
        return this.currentSession;
      }
    } catch {
      // No existing session
    }

    // Create new session
    if (this.options.inZellijSession) {
      // We're inside Zellij, create a tab or use current session
      try {
        execSync(`zellij action new-tab --name "${sessionName}"`, {
          stdio: "pipe",
        });
      } catch {
        // Use current session
      }

      this.currentSession = {
        name: sessionName,
        attached: true,
      };
    } else {
      // We'll create a new detached session
      // The actual creation happens in executeInZellij
      this.currentSession = {
        name: sessionName,
        attached: false,
      };
    }

    return this.currentSession;
  }

  /**
   * Generate a unique session ID.
   */
  private generateSessionId(): string {
    return `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  /**
   * Find the pi CLI executable path.
   */
  private findPiCli(): string {
    const possiblePaths = [
      path.join(process.env.HOME || "", ".npm-global", "bin", "pi"),
      path.join(process.env.HOME || "", ".local", "bin", "pi"),
      "npx",
      "pi",
      path.join(__dirname, "..", "..", "node_modules", ".bin", "pi"),
    ];

    if (process.env.PATH) {
      const pathEnv = process.env.PATH.split(path.delimiter);
      for (const dir of pathEnv) {
        const piPath = path.join(dir, "pi");
        possiblePaths.push(piPath);
      }
    }

    return "npx";
  }

  /**
   * Extract a summary from stdout output.
   */
  private extractSummary(stdout: string): string | null {
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

  /**
   * Save Zellij session metadata for the workflow run.
   */
  async saveZellijMetadata(
    runDir: string,
    sessionId: string,
    workflowId: string,
    runId: string,
    paneId?: string,
    stepId?: string
  ): Promise<void> {
    const metadataPath = path.join(runDir, "zellij.json");

    const metadata = {
      sessionId,
      workflowId,
      runId,
      zellijSession: this.currentSession?.name,
      paneId,
      stepId,
      displayStrategy: this.options.displayStrategy,
      inZellijSession: this.options.inZellijSession,
    };

    await fs.writeFile(metadataPath, JSON.stringify(metadata, null, 2), "utf8");
  }
}
