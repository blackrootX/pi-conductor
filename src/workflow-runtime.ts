import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, AgentSource } from "./agents.js";
import { discoverAgents } from "./agents.js";
import {
  applyOnStepErrorPatch,
  createImmutableHookSnapshot,
  mergeAfterStepPatch,
  mergeBeforeStepPatch,
  mergeOnStepErrorPatch,
  mergeSharedStatePatch,
  type OnStepErrorPatch,
  type WorkflowRuntimeError,
  type WorkflowRuntimeErrorStage,
  type WorkflowRuntimeHooks,
} from "./workflow-hooks.js";
import { renderRepairPrompt, renderStructuredStepPrompt } from "./workflow-prompts.js";
import { parseAgentResult } from "./workflow-result.js";
import {
  buildFinalTextFromState,
  buildWorkOrder,
  completeWorkflowState,
  createWorkflowState,
  markStepFailure,
  markStepRunning,
  mergeAgentResultIntoState,
} from "./workflow-state.js";
import type { AgentResult, WorkflowConfig, WorkflowState } from "./workflow-types.js";
import { discoverWorkflows } from "./workflows.js";

const REPAIR_SYSTEM_PROMPT = [
  "You repair workflow step outputs into a structured result contract.",
  "Do not invent repository changes or verification that are not supported by the provided text.",
  "Preserve the most faithful interpretation of the original step output.",
  "Return the required structured result block exactly once.",
].join("\n");

export interface UsageStats {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
}

export interface SingleResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  task: string;
  objective?: string;
  exitCode: number;
  elapsedMs: number;
  lastWork: string;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
  stepId?: string;
  rawFinalText?: string;
  repairedFinalText?: string;
  parseError?: string;
  repairAttempted?: boolean;
  structuredStatus?: AgentResult["status"];
  diagnostics?: string[];
}

export interface WorkflowDetails {
  workflowName: string;
  steps: WorkflowConfig["steps"];
  workflowSource: WorkflowConfig["source"];
  workflowFilePath: string | null;
  results: SingleResult[];
  state: WorkflowState;
}

export type WorkflowUpdate = WorkflowDetails;

export interface WorkflowRunResult {
  workflowName: string;
  steps: WorkflowConfig["steps"];
  workflowSource: WorkflowConfig["source"];
  workflowFilePath: string | null;
  results: SingleResult[];
  state: WorkflowState;
  finalText: string;
  isError: boolean;
  errorMessage?: string;
}

export type WorkflowUpdateCallback = (details: WorkflowUpdate) => void;

type RunSingleAgentOptions = {
  defaultCwd: string;
  agents: AgentConfig[];
  agentName: string;
  task: string;
  defaultModel: string | undefined;
  step: number;
  stepId: string;
  objective: string;
  signal: AbortSignal | undefined;
  onUpdate: ((result: SingleResult) => void) | undefined;
  systemPromptOverride?: string;
  toolsOverride?: string[];
};

type WorkflowPersistence = {
  runDir: string;
  stepsDir: string;
};

const TOOL_POLICY_ENV = "PI_CONDUCTOR_ENFORCE_TOOLS";
const ALLOWED_TOOLS_ENV = "PI_CONDUCTOR_ALLOWED_TOOLS";

function writePromptToTempFile(
  agentName: string,
  prompt: string,
): { dir: string; filePath: string } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-conductor-"));
  const safeName = agentName.replace(/[^\w.-]+/g, "_");
  const filePath = path.join(tempDir, `prompt-${safeName}.md`);
  fs.writeFileSync(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return { dir: tempDir, filePath };
}

export function getFinalOutput(messages: Message[]): string {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    for (const part of message.content) {
      if (part.type === "text") return part.text;
    }
  }
  return "";
}

export function isErrorResult(result: SingleResult): boolean {
  return (
    result.exitCode !== 0 ||
    result.stopReason === "error" ||
    result.stopReason === "aborted" ||
    result.structuredStatus === "failed" ||
    result.structuredStatus === "blocked"
  );
}

function makeEmptyUsage(): UsageStats {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    contextTokens: 0,
    turns: 0,
  };
}

function createPersistence(cwd: string, runId: string): WorkflowPersistence {
  const runDir = path.join(cwd, ".pi", "workflow-runs", runId);
  const stepsDir = path.join(runDir, "steps");
  fs.mkdirSync(stepsDir, { recursive: true });
  return { runDir, stepsDir };
}

function sanitizeFileNamePart(input: string): string {
  return input.replace(/[^\w.-]+/g, "-");
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function persistWorkflowState(
  persistence: WorkflowPersistence,
  workflow: WorkflowConfig,
  state: WorkflowState,
  results: SingleResult[],
): void {
  writeJsonFile(path.join(persistence.runDir, "state.json"), {
    runId: state.runId,
    workflowName: workflow.name,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    status: state.status,
    startedAt: state.startedAt,
    finishedAt: state.finishedAt,
    resultCount: results.length,
    state,
  });
}

function persistStepResult(
  persistence: WorkflowPersistence,
  stepIndex: number,
  stepAgent: string,
  result: SingleResult,
  parsedResult?: AgentResult,
): void {
  const fileName = `${String(stepIndex + 1).padStart(2, "0")}-${sanitizeFileNamePart(stepAgent)}.result.json`;
  writeJsonFile(path.join(persistence.stepsDir, fileName), {
    step: result.step,
    stepId: result.stepId,
    agent: result.agent,
    agentSource: result.agentSource,
    objective: result.objective,
    exitCode: result.exitCode,
    structuredStatus: result.structuredStatus,
    parseError: result.parseError,
    repairAttempted: result.repairAttempted,
    rawFinalText: result.rawFinalText,
    repairedFinalText: result.repairedFinalText,
    parsedResult: parsedResult ?? null,
    diagnostics: result.diagnostics ?? null,
    usage: result.usage,
    model: result.model,
    stderr: result.stderr,
    errorMessage: result.errorMessage,
    lastWork: result.lastWork,
  });
}

function makeWorkflowDetails(
  workflow: WorkflowConfig,
  results: SingleResult[],
  state: WorkflowState,
): WorkflowDetails {
  return {
    workflowName: workflow.name,
    steps: workflow.steps,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    results,
    state,
  };
}

function buildStructuredStopMessage(
  result: AgentResult,
  stepNumber: number,
  agentName: string,
): string {
  const blockerDetails =
    result.blockers?.map((item) => item.issue).filter(Boolean).join("; ") ?? "";
  const suffix = blockerDetails ? ` ${blockerDetails}` : "";
  return `Workflow stopped at step ${stepNumber} (${agentName}): ${result.status}.${suffix}`.trim();
}

function describeUnknownError(error: unknown): string {
  if (error instanceof Error) {
    const message = error.message.trim();
    return message || error.name || "Unknown error";
  }
  if (typeof error === "string") {
    const trimmed = error.trim();
    return trimmed || "Unknown error";
  }
  return "Unknown error";
}

function mergeDiagnostics(
  current: string[] | undefined,
  patch: string[] | undefined,
): string[] | undefined {
  if (!patch || patch.length === 0) return current;
  const merged = new Set<string>();
  for (const item of current ?? []) {
    const trimmed = item.trim();
    if (trimmed) merged.add(trimmed);
  }
  for (const item of patch) {
    const trimmed = item.trim();
    if (trimmed) merged.add(trimmed);
  }
  return Array.from(merged.values());
}

function createSyntheticFailureResult(options: {
  agentName: string;
  agentSource: AgentSource | "unknown";
  task: string;
  objective: string;
  step: number;
  stepId: string;
  stderr: string;
  model?: string;
}): SingleResult {
  return {
    agent: options.agentName,
    agentSource: options.agentSource,
    task: options.task,
    objective: options.objective,
    exitCode: 1,
    elapsedMs: 0,
    lastWork: "",
    messages: [],
    stderr: options.stderr,
    usage: makeEmptyUsage(),
    model: options.model,
    step: options.step,
    stepId: options.stepId,
  };
}

function markWorkflowFailed(state: WorkflowState): void {
  state.status = "failed";
  state.finishedAt = new Date().toISOString();
}

async function runSingleAgent(options: RunSingleAgentOptions): Promise<SingleResult> {
  const {
    defaultCwd,
    agents,
    agentName,
    task,
    defaultModel,
    step,
    stepId,
    objective,
    signal,
    onUpdate,
    systemPromptOverride,
    toolsOverride,
  } = options;

  const agent = agents.find((item) => item.name === agentName);
  if (!agent) {
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      objective,
      exitCode: 1,
      elapsedMs: 0,
      lastWork: "",
      messages: [],
      stderr: `Unknown agent: "${agentName}"`,
      usage: makeEmptyUsage(),
      step,
      stepId,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  const resolvedModel = agent.model ?? defaultModel;
  if (resolvedModel) args.push("--model", resolvedModel);

  const tools = toolsOverride ?? agent.tools;
  const hasExplicitToolPolicy = toolsOverride !== undefined || agent.tools !== undefined;
  if (tools && tools.length > 0) {
    args.push("--tools", tools.join(","));
  }

  let tempPromptDir: string | null = null;
  let tempPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    objective,
    exitCode: 0,
    elapsedMs: 0,
    lastWork: "",
    messages: [],
    stderr: "",
    usage: makeEmptyUsage(),
    model: resolvedModel,
    step,
    stepId,
  };

  const emitUpdate = () => {
    currentResult.elapsedMs = Date.now() - startTime;
    currentResult.lastWork = getFinalOutput(currentResult.messages);
    onUpdate?.({ ...currentResult, messages: [...currentResult.messages] });
  };
  const startTime = Date.now();

  try {
    const systemPrompt = systemPromptOverride ?? agent.systemPrompt;
    if (systemPrompt.trim()) {
      const tempPrompt = writePromptToTempFile(agent.name, systemPrompt);
      tempPromptDir = tempPrompt.dir;
      tempPromptPath = tempPrompt.filePath;
      args.push("--append-system-prompt", tempPromptPath);
    }

    args.push(task);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: defaultCwd,
        env: hasExplicitToolPolicy
          ? {
              ...process.env,
              [TOOL_POLICY_ENV]: "1",
              [ALLOWED_TOOLS_ENV]: tools?.join(",") ?? "",
            }
          : process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: unknown;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          "message" in event &&
          (event as { type?: string }).type === "message_end"
        ) {
          const message = (event as { message?: Message }).message;
          if (!message) return;
          currentResult.messages.push(message);

          if (message.role === "assistant") {
            currentResult.usage.turns++;
            const usage = message.usage;
            if (usage) {
              currentResult.usage.input += usage.input || 0;
              currentResult.usage.output += usage.output || 0;
              currentResult.usage.cacheRead += usage.cacheRead || 0;
              currentResult.usage.cacheWrite += usage.cacheWrite || 0;
              currentResult.usage.cost += usage.cost?.total || 0;
              currentResult.usage.contextTokens = usage.totalTokens || 0;
            }
            if (!currentResult.model && message.model) {
              currentResult.model = message.model;
            }
            if (message.stopReason) currentResult.stopReason = message.stopReason;
            if (message.errorMessage) currentResult.errorMessage = message.errorMessage;
          }
          emitUpdate();
        }

        if (
          typeof event === "object" &&
          event !== null &&
          "type" in event &&
          "message" in event &&
          (event as { type?: string }).type === "tool_result_end"
        ) {
          const message = (event as { message?: Message }).message;
          if (!message) return;
          currentResult.messages.push(message);
          emitUpdate();
        }
      };

      proc.stdout.on("data", (data) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) processLine(line);
      });

      proc.stderr.on("data", (data) => {
        currentResult.stderr += data.toString();
      });

      const interval = onUpdate ? setInterval(() => emitUpdate(), 1000) : null;

      proc.on("close", (code) => {
        if (interval) clearInterval(interval);
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => {
        if (interval) clearInterval(interval);
        resolve(1);
      });

      if (signal) {
        const killProc = () => {
          wasAborted = true;
          proc.kill("SIGTERM");
          setTimeout(() => {
            if (!proc.killed) proc.kill("SIGKILL");
          }, 5000);
        };
        if (signal.aborted) killProc();
        else signal.addEventListener("abort", killProc, { once: true });
      }
    });

    currentResult.exitCode = exitCode;
    currentResult.elapsedMs = Date.now() - startTime;
    currentResult.lastWork = getFinalOutput(currentResult.messages);
    if (wasAborted) throw new Error("Workflow step was aborted");
    return currentResult;
  } finally {
    if (tempPromptPath) {
      try {
        fs.unlinkSync(tempPromptPath);
      } catch {
        /* ignore */
      }
    }
    if (tempPromptDir) {
      try {
        fs.rmdirSync(tempPromptDir);
      } catch {
        /* ignore */
      }
    }
  }
}

export async function runWorkflowByName(
  cwd: string,
  workflowName: string,
  task: string,
  defaultModel?: string,
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdateCallback,
  runtimeHooks: WorkflowRuntimeHooks = {},
): Promise<WorkflowRunResult> {
  const { agents } = discoverAgents(cwd);
  const { workflows } = discoverWorkflows(cwd);
  const workflow = workflows.find((item) => item.name === workflowName);

  if (!workflow) {
    return {
      workflowName,
      steps: [],
      workflowSource: "built-in",
      workflowFilePath: null,
      results: [],
      state: createWorkflowState(
        { name: workflowName, steps: [], source: "built-in" },
        task,
        randomUUID(),
      ),
      finalText: "",
      isError: true,
      errorMessage: `Unknown workflow: "${workflowName}"`,
    };
  }

  const missingAgents = workflow.steps
    .map((step) => step.agent)
    .filter((agentName) => !agents.some((agent) => agent.name === agentName));
  if (missingAgents.length > 0) {
    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      results: [],
      state: createWorkflowState(workflow, task, randomUUID()),
      finalText: "",
      isError: true,
      errorMessage: `Workflow "${workflow.name}" cannot start. Missing agents: ${missingAgents.join(", ")}.`,
    };
  }

  const state = createWorkflowState(workflow, task, randomUUID());
  const persistence = createPersistence(cwd, state.runId);
  const results: SingleResult[] = [];
  const hooks = runtimeHooks;

  const emitDetails = (partialResults = results) => {
    onUpdate?.(makeWorkflowDetails(workflow, partialResults, state));
  };

  const runOnStepErrorHook = async (
    input: Parameters<NonNullable<WorkflowRuntimeHooks["onStepError"]>>[0],
  ): Promise<OnStepErrorPatch | undefined> => {
    if (!hooks.onStepError) return undefined;

    try {
      const patch = await hooks.onStepError(input);
      return patch ?? undefined;
    } catch (hookError) {
      return mergeOnStepErrorPatch(undefined, {
        diagnostics: [`onStepError hook failed: ${describeUnknownError(hookError)}`],
      });
    }
  };

  const failStep = async (options: {
    index: number;
    step: WorkflowConfig["steps"][number];
    agent: AgentConfig | undefined;
    workOrder?: ReturnType<typeof buildWorkOrder>;
    stage: WorkflowRuntimeErrorStage;
    error: unknown;
    resultRecord?: SingleResult;
    rawFinalText?: string;
    repairedFinalText?: string;
    parseError?: string;
    messagePrefix: string;
  }): Promise<WorkflowRunResult> => {
    const {
      index,
      step,
      agent,
      workOrder,
      stage,
      error,
      rawFinalText,
      repairedFinalText,
      parseError,
      messagePrefix,
    } = options;

    const workflowError: WorkflowRuntimeError = {
      stage,
      workflowName: workflow.name,
      stepIndex: index,
      stepId: step.id,
      agent: step.agent,
      message: describeUnknownError(error),
      stderr: options.resultRecord?.stderr,
      rawFinalText,
      repairedFinalText,
      parseError,
    };

    let errorPatch = await runOnStepErrorHook({
      cwd,
      workflow: createImmutableHookSnapshot(workflow),
      agent: agent ? createImmutableHookSnapshot(agent) : undefined,
      state: createImmutableHookSnapshot(state),
      stepIndex: index,
      workOrder: workOrder
        ? createImmutableHookSnapshot(workOrder)
        : undefined,
      error: createImmutableHookSnapshot(workflowError),
    });

    applyOnStepErrorPatch(state, index, errorPatch);

    const failureResult =
      options.resultRecord ??
      createSyntheticFailureResult({
        agentName: step.agent,
        agentSource: agent?.source ?? "unknown",
        task: workOrder ? renderStructuredStepPrompt(workOrder) : task,
        objective: workOrder?.objective ?? state.steps[index]?.objective ?? "",
        step: index + 1,
        stepId: step.id,
        stderr: workflowError.message,
        model: agent?.model ?? defaultModel,
      });

    failureResult.objective = workOrder?.objective ?? failureResult.objective;
    failureResult.rawFinalText = rawFinalText ?? failureResult.rawFinalText;
    failureResult.repairedFinalText =
      repairedFinalText ?? failureResult.repairedFinalText;
    failureResult.parseError = parseError ?? failureResult.parseError;
    failureResult.diagnostics = mergeDiagnostics(
      failureResult.diagnostics,
      errorPatch?.diagnostics,
    );
    if (errorPatch?.summary?.trim()) {
      failureResult.lastWork = errorPatch.summary.trim();
    }

    markStepFailure(state, index, "failed");
    results.push(failureResult);
    persistStepResult(
      persistence,
      index,
      step.agent,
      failureResult,
      state.steps[index]?.result,
    );
    persistWorkflowState(persistence, workflow, state, results);
    emitDetails();

    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      results,
      state,
      finalText: "",
      isError: true,
      errorMessage: `${messagePrefix}: ${workflowError.message}`,
    };
  };

  try {
    const beforeWorkflowPatch = await hooks.beforeWorkflow?.({
      cwd,
      workflow: createImmutableHookSnapshot(workflow),
      agents: createImmutableHookSnapshot(agents),
      defaultModel,
      state: createImmutableHookSnapshot(state),
    });
    if (beforeWorkflowPatch?.shared) {
      state.shared = mergeSharedStatePatch(state.shared, beforeWorkflowPatch.shared);
    }
  } catch (error) {
    markWorkflowFailed(state);
    persistWorkflowState(persistence, workflow, state, results);
    emitDetails();
    return {
      workflowName: workflow.name,
      steps: workflow.steps,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      results,
      state,
      finalText: "",
      isError: true,
      errorMessage: `Workflow "${workflow.name}" could not start: ${describeUnknownError(error)}`,
    };
  }

  persistWorkflowState(persistence, workflow, state, results);

  for (let index = 0; index < workflow.steps.length; index++) {
    const step = workflow.steps[index];
    const agent = agents.find((item) => item.name === step.agent);
    let workOrder = buildWorkOrder(state, step, agent, index);
    state.steps[index].objective = workOrder.objective;
    markStepRunning(state, index);
    persistWorkflowState(persistence, workflow, state, results);
    emitDetails();

    try {
      const beforeStepPatch = await hooks.beforeStep?.({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(state),
        stepIndex: index,
        workOrder: createImmutableHookSnapshot(workOrder),
      });
      workOrder = mergeBeforeStepPatch(workOrder, beforeStepPatch ?? undefined);
    } catch (error) {
      return await failStep({
        index,
        step,
        agent,
        workOrder,
        stage: "beforeStep",
        error,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during beforeStep hook`,
      });
    }

    state.steps[index].objective = workOrder.objective;
    persistWorkflowState(persistence, workflow, state, results);
    emitDetails();

    const stepPrompt = renderStructuredStepPrompt(workOrder);

    let primaryResult: SingleResult;
    try {
      primaryResult = await runSingleAgent({
        defaultCwd: cwd,
        agents,
        agentName: step.agent,
        task: stepPrompt,
        defaultModel,
        step: index + 1,
        stepId: step.id,
        objective: workOrder.objective,
        signal,
        onUpdate: onUpdate
          ? (partialResult) => {
              emitDetails([...results, partialResult]);
            }
          : undefined,
      });
    } catch (error) {
      return await failStep({
        index,
        step,
        agent,
        workOrder,
        stage: "agent",
        error,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    const rawFinalText = getFinalOutput(primaryResult.messages);
    primaryResult.rawFinalText = rawFinalText;
    primaryResult.objective = workOrder.objective;

    if (
      primaryResult.exitCode !== 0 ||
      primaryResult.stopReason === "error" ||
      primaryResult.stopReason === "aborted"
    ) {
      return await failStep({
        index,
        step,
        agent,
        workOrder,
        stage: "agent",
        error:
          primaryResult.errorMessage ||
          primaryResult.stderr ||
          rawFinalText ||
          "(no output)",
        resultRecord: primaryResult,
        rawFinalText,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    let parseOutcome = parseAgentResult(rawFinalText);
    let finalResultRecord = primaryResult;
    let repairedFinalText: string | undefined;
    let parseError: string | undefined;

    if (!parseOutcome.ok) {
      parseError = parseOutcome.error;
      state.steps[index].parseError = parseError;
      persistWorkflowState(persistence, workflow, state, results);
      emitDetails();

      let repairResult: SingleResult;
      try {
        repairResult = await runSingleAgent({
          defaultCwd: cwd,
          agents,
          agentName: step.agent,
          task: renderRepairPrompt(rawFinalText, parseError),
          defaultModel,
          step: index + 1,
          stepId: step.id,
          objective: `${workOrder.objective} (repair structured output)`,
          signal,
          onUpdate: onUpdate
            ? (partialResult) => {
                partialResult.parseError = parseError;
                partialResult.repairAttempted = true;
                partialResult.rawFinalText = rawFinalText;
                emitDetails([...results, partialResult]);
              }
            : undefined,
          systemPromptOverride: REPAIR_SYSTEM_PROMPT,
          toolsOverride: [],
        });
      } catch (error) {
        return await failStep({
          index,
          step,
          agent,
          workOrder,
          stage: "repair",
          error,
          rawFinalText,
          parseError,
          messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during structured output repair`,
        });
      }

      repairedFinalText = getFinalOutput(repairResult.messages);
      repairResult.rawFinalText = rawFinalText;
      repairResult.repairedFinalText = repairedFinalText;
      repairResult.parseError = parseError;
      repairResult.repairAttempted = true;
      repairResult.objective = workOrder.objective;
      finalResultRecord = repairResult;

      if (
        repairResult.exitCode !== 0 ||
        repairResult.stopReason === "error" ||
        repairResult.stopReason === "aborted"
      ) {
        return await failStep({
          index,
          step,
          agent,
          workOrder,
          stage: "repair",
          error:
            repairResult.errorMessage ||
            repairResult.stderr ||
            repairedFinalText ||
            "(no output)",
          resultRecord: repairResult,
          rawFinalText,
          repairedFinalText,
          parseError,
          messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during structured output repair`,
        });
      }

      parseOutcome = parseAgentResult(repairedFinalText);
    }

    if (!parseOutcome.ok) {
      finalResultRecord.parseError = parseOutcome.error;
      finalResultRecord.repairAttempted = true;
      finalResultRecord.rawFinalText = rawFinalText;
      finalResultRecord.repairedFinalText = repairedFinalText;
      return await failStep({
        index,
        step,
        agent,
        workOrder,
        stage: "parse",
        error: parseOutcome.error,
        resultRecord: finalResultRecord,
        rawFinalText,
        repairedFinalText,
        parseError: parseOutcome.error,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent})`,
      });
    }

    let structuredResult = parseOutcome.result;
    try {
      const afterStepPatch = await hooks.afterStep?.({
        cwd,
        workflow: createImmutableHookSnapshot(workflow),
        agent: agent ? createImmutableHookSnapshot(agent) : undefined,
        state: createImmutableHookSnapshot(state),
        stepIndex: index,
        workOrder: createImmutableHookSnapshot(workOrder),
        result: createImmutableHookSnapshot(structuredResult),
      });
      structuredResult = mergeAfterStepPatch(
        structuredResult,
        afterStepPatch ?? undefined,
      );
    } catch (error) {
      finalResultRecord.structuredStatus = structuredResult.status;
      finalResultRecord.rawFinalText = rawFinalText;
      finalResultRecord.repairedFinalText = repairedFinalText;
      finalResultRecord.parseError = parseError;
      finalResultRecord.repairAttempted = Boolean(parseError);
      return await failStep({
        index,
        step,
        agent,
        workOrder,
        stage: "afterStep",
        error,
        resultRecord: finalResultRecord,
        rawFinalText,
        repairedFinalText,
        parseError,
        messagePrefix: `Workflow stopped at step ${index + 1} (${step.agent}) during afterStep hook`,
      });
    }

    finalResultRecord.structuredStatus = structuredResult.status;
    finalResultRecord.rawFinalText = rawFinalText;
    finalResultRecord.repairedFinalText = repairedFinalText;
    finalResultRecord.parseError = parseError;
    finalResultRecord.repairAttempted = Boolean(parseError);
    finalResultRecord.lastWork = structuredResult.summary;

    mergeAgentResultIntoState(
      state,
      index,
      structuredResult,
      rawFinalText,
      repairedFinalText,
      parseError,
    );
    results.push(finalResultRecord);
    persistStepResult(
      persistence,
      index,
      step.agent,
      finalResultRecord,
      state.steps[index]?.result,
    );
    persistWorkflowState(persistence, workflow, state, results);
    emitDetails();

    if (structuredResult.status === "blocked" || structuredResult.status === "failed") {
      return {
        workflowName: workflow.name,
        steps: workflow.steps,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        results,
        state,
        finalText: "",
        isError: true,
        errorMessage: buildStructuredStopMessage(structuredResult, index + 1, step.agent),
      };
    }
  }

  completeWorkflowState(state);
  persistWorkflowState(persistence, workflow, state, results);

  return {
    workflowName: workflow.name,
    steps: workflow.steps,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    results,
    state,
    finalText: buildFinalTextFromState(state),
    isError: false,
  };
}
