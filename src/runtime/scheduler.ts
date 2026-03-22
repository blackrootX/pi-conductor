// src/runtime/scheduler.ts - DAG-based scheduler for workflow execution

import type {
  ResolvedWorkflow,
  ResolvedWorkflowStep,
  StepResultEnvelope,
} from "../workflow/types";
import {
  buildApprovalRequest,
  normalizeApprovalResult,
  type WorkflowApprovalHandler,
} from "../workflow/approval";
import type { SessionRunner } from "./childSessionRunner";

export interface SchedulerOptions {
  /** Maximum parallel steps */
  maxParallelism?: number;
  /** Behavior on step failure */
  onStepFailure?: "abort" | "continue";
  /** Workflow timeout in milliseconds */
  timeout?: number;
  /** Abort controller for cancellation */
  abortController?: AbortController;
  /** Callback when a step becomes pending */
  onStepPending?: (step: ResolvedWorkflowStep) => void;
  /** Callback when a step becomes running */
  onStepRunning?: (step: ResolvedWorkflowStep, sessionId: string) => void;
  /** Callback when a step starts */
  onStepStart?: (step: ResolvedWorkflowStep, sessionId: string) => void;
  /** Callback when a step completes successfully */
  onStepComplete?: (stepId: string, result: StepResultEnvelope) => void;
  /** Callback when a step fails */
  onStepFail?: (stepId: string, error: string) => void;
  /** Callback when workflow times out */
  onWorkflowTimeout?: (timeoutMs: number) => void;
  /** Callback when workflow is cancelled */
  onWorkflowCancelled?: (reason: string) => void;
  /** Callback when a step requires approval */
  onStepApprovalRequested?: (step: ResolvedWorkflowStep) => void;
  /** Callback when approval is resolved */
  onStepApprovalResolved?: (step: ResolvedWorkflowStep, approved: boolean, reason?: string) => void;
  /** Async handler for approval-gated steps */
  approvalHandler?: WorkflowApprovalHandler;
}

export interface SchedulerResult {
  success: boolean;
  results: Record<string, StepResultEnvelope>;
  aborted: boolean;
  timedOut: boolean;
  cancelled: boolean;
  failedStepIds: string[];
}

/**
 * DAG-based scheduler for workflow execution.
 * Supports both sequential and parallel execution.
 */
export class Scheduler {
  private workflow: ResolvedWorkflow;
  private runner: SessionRunner;
  private options: SchedulerOptions;
  private results: Record<string, StepResultEnvelope> = {};
  private pendingSteps: Set<string>;
  private runningSteps: Set<string>;
  private completedSteps: Set<string>;
  private failedSteps: Set<string>;
  private runningSessionIds: Map<string, string>;
  private userTask: string;
  private timedOut = false;
  private cancelled = false;
  private cancellationReason?: string;

  constructor(
    workflow: ResolvedWorkflow,
    runner: SessionRunner,
    userTask: string,
    options: SchedulerOptions = {}
  ) {
    this.workflow = workflow;
    this.runner = runner;
    this.userTask = userTask;
    this.options = {
      maxParallelism: workflow.policy.maxParallelism ?? 1,
      onStepFailure: workflow.policy.onStepFailure ?? "abort",
      ...options,
    };

    this.pendingSteps = new Set(workflow.steps.map((s) => s.id));
    this.runningSteps = new Set();
    this.completedSteps = new Set();
    this.failedSteps = new Set();
    this.runningSessionIds = new Map();

    // Set up abort controller listener if provided
    if (this.options.abortController) {
      this.options.abortController.signal.addEventListener("abort", () => {
        if (!this.timedOut) {
          this.cancelled = true;
          this.cancellationReason = "Workflow execution was cancelled";
          this.options.onWorkflowCancelled?.(this.cancellationReason);
          void this.cancelRunningSteps();
        }
      });
    }
  }

  /**
   * Execute the workflow according to the schedule.
   */
  async execute(): Promise<SchedulerResult> {
    const timeout = this.options.timeout;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    // Set up timeout if specified
    if (timeout) {
      timeoutId = setTimeout(() => {
        this.timedOut = true;
        this.cancellationReason = `Workflow execution timed out after ${timeout}ms`;
        this.options.onWorkflowTimeout?.(timeout);
        void this.cancelRunningSteps();
      }, timeout);
    }

    try {
      while (this.hasWork()) {
        // Check if we should abort due to failure, timeout, or cancellation
        if (this.shouldAbort()) {
          await this.cancelRunningSteps();
          break;
        }

        // Run any steps that are ready
        await this.runReadySteps();
      }

      return {
        success: this.failedSteps.size === 0 && !this.timedOut && !this.cancelled,
        results: this.results,
        aborted: this.shouldAbort() || this.timedOut || this.cancelled,
        timedOut: this.timedOut,
        cancelled: this.cancelled,
        failedStepIds: Array.from(this.failedSteps),
      };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  /**
   * Check if there's still work to do.
   */
  private hasWork(): boolean {
    return this.pendingSteps.size > 0 || this.runningSteps.size > 0;
  }

  /**
   * Check if execution should abort.
   */
  private shouldAbort(): boolean {
    // Abort immediately if timed out or cancelled
    if (this.timedOut || this.cancelled) {
      return true;
    }

    if (this.options.onStepFailure === "continue") {
      return false;
    }

    // Abort if any step failed and is blocking other steps
    return Array.from(this.failedSteps).some((failedId) => {
      return this.workflow.steps.some((step) => step.dependsOn?.includes(failedId));
    });
  }

  /**
   * Run all steps that are ready to execute.
   */
  private async runReadySteps(): Promise<void> {
    const readySteps = this.getReadySteps();

    // Limit parallelism
    const maxSlots = this.options.maxParallelism! - this.runningSteps.size;
    const stepsToRun = readySteps.slice(0, Math.max(0, maxSlots));

    // Start running steps
    const promises = stepsToRun.map((step) => this.runStep(step));

    // Wait for all started steps to complete
    await Promise.all(promises);
  }

  /**
   * Get steps that are ready to run (all dependencies satisfied).
   */
  private getReadySteps(): ResolvedWorkflowStep[] {
    const ready: ResolvedWorkflowStep[] = [];

    for (const step of this.workflow.steps) {
      // Skip if already processed
      if (
        this.completedSteps.has(step.id) ||
        this.failedSteps.has(step.id) ||
        this.runningSteps.has(step.id) ||
        this.pendingSteps.has(step.id) === false
      ) {
        continue;
      }

      // Check if all dependencies are complete
      if (this.areDependenciesMet(step)) {
        ready.push(step);
      }
    }

    // Sort by dependency order (steps with fewer unmet dependencies first)
    return ready.sort((a, b) => {
      const aUnmet = (a.dependsOn || []).filter(
        (d) => !this.completedSteps.has(d)
      ).length;
      const bUnmet = (b.dependsOn || []).filter(
        (d) => !this.completedSteps.has(d)
      ).length;
      return aUnmet - bUnmet;
    });
  }

  /**
   * Check if all dependencies of a step are met.
   */
  private areDependenciesMet(step: ResolvedWorkflowStep): boolean {
    if (!step.dependsOn || step.dependsOn.length === 0) {
      return true;
    }

    return step.dependsOn.every((depId) => {
      // Dependency must be completed successfully
      return this.completedSteps.has(depId);
    });
  }

  /**
   * Run a single step.
   */
  private async runStep(step: ResolvedWorkflowStep): Promise<void> {
    this.pendingSteps.delete(step.id);
    this.runningSteps.add(step.id);

    // Generate session ID for this step
    const sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
    this.runningSessionIds.set(step.id, sessionId);

    // Emit step:pending event
    this.options.onStepPending?.(step);

    // Set initial pending status
    this.results[step.id] = {
      stepId: step.id,
      stepTitle: step.title,
      agentId: step.agent.id,
      agentName: step.agent.name,
      sessionId,
      status: "pending",
      summary: "",
      artifact: { type: "text", value: "" },
      startedAt: new Date().toISOString(),
    };

    if (step.requiresApproval) {
      this.options.onStepApprovalRequested?.(step);

      const approval = this.options.approvalHandler
        ? normalizeApprovalResult(
            await this.options.approvalHandler(
              buildApprovalRequest(this.workflow.spec.id, this.workflow.spec.name, step)
            )
          )
        : { approved: true, reason: "No approval handler configured; auto-approved" };

      this.options.onStepApprovalResolved?.(step, approval.approved, approval.reason);

      if (!approval.approved) {
        const rejectionMessage = approval.reason || "Step approval was rejected";
        const rejectedResult: StepResultEnvelope = {
          stepId: step.id,
          stepTitle: step.title,
          agentId: step.agent.id,
          agentName: step.agent.name,
          sessionId,
          status: "cancelled",
          summary: rejectionMessage,
          artifact: { type: "text", value: "" },
          startedAt: this.results[step.id]?.startedAt || new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          error: rejectionMessage,
        };

        this.results[step.id] = rejectedResult;
        this.failedSteps.add(step.id);
        this.options.onStepComplete?.(step.id, rejectedResult);
        return;
      }
    }

    // Emit step:running event
    this.options.onStepRunning?.(step, sessionId);

    // Notify step start
    this.options.onStepStart?.(step, sessionId);

    try {
      const result = await this.runner.runStep(
        step,
        this.userTask,
        this.results,
        this.workflow.steps,
        sessionId
      );

      this.results[step.id] = result;

      if (result.status === "succeeded") {
        this.completedSteps.add(step.id);
      } else if (result.status === "failed" || result.status === "timed_out" || result.status === "cancelled") {
        this.failedSteps.add(step.id);
      }

      this.options.onStepComplete?.(step.id, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      const failedResult: StepResultEnvelope = {
        stepId: step.id,
        stepTitle: step.title,
        agentId: step.agent.id,
        agentName: step.agent.name,
        sessionId,
        status: "failed",
        summary: "",
        artifact: { type: "text", value: "" },
        startedAt: this.results[step.id]?.startedAt || new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        error: errorMessage,
      };

      this.results[step.id] = failedResult;

      this.failedSteps.add(step.id);
      this.options.onStepComplete?.(step.id, failedResult);
      this.options.onStepFail?.(step.id, errorMessage);
    } finally {
      this.runningSteps.delete(step.id);
      this.runningSessionIds.delete(step.id);
    }
  }

  /**
   * Cancel any currently running steps when the workflow is aborted.
   */
  private async cancelRunningSteps(): Promise<void> {
    if (!this.runner.cancelStep || this.runningSessionIds.size === 0) {
      return;
    }

    const sessionIds = Array.from(this.runningSessionIds.values());
    await Promise.allSettled(sessionIds.map((sessionId) => this.runner.cancelStep!(sessionId)));
  }

  /**
   * Get current execution state.
   */
  getState(): {
    pending: string[];
    running: string[];
    completed: string[];
    failed: string[];
  } {
    return {
      pending: Array.from(this.pendingSteps),
      running: Array.from(this.runningSteps),
      completed: Array.from(this.completedSteps),
      failed: Array.from(this.failedSteps),
    };
  }

  /**
   * Check if a specific step has completed.
   */
  isStepCompleted(stepId: string): boolean {
    return this.completedSteps.has(stepId);
  }

  /**
   * Get result for a specific step.
   */
  getStepResult(stepId: string): StepResultEnvelope | undefined {
    return this.results[stepId];
  }
}

/**
 * Simple sequential scheduler (always runs one step at a time).
 */
export class SequentialScheduler extends Scheduler {
  constructor(
    workflow: ResolvedWorkflow,
    runner: SessionRunner,
    userTask: string,
    options: SchedulerOptions = {}
  ) {
    super(workflow, runner, userTask, {
      ...options,
      maxParallelism: 1,
    });
  }
}

/**
 * Create a scheduler based on workflow policy.
 */
export function createScheduler(
  workflow: ResolvedWorkflow,
  runner: SessionRunner,
  userTask: string,
  options?: SchedulerOptions
): Scheduler {
  if (workflow.policy.maxParallelism === 1) {
    return new SequentialScheduler(workflow, runner, userTask, options);
  }

  return new Scheduler(workflow, runner, userTask, options);
}
