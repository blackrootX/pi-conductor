import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@mariozechner/pi-ai";
import type { AgentConfig, AgentSource } from "./agents.js";
import { discoverAgents } from "./agents.js";
import type { WorkflowSource } from "./workflows.js";
import { discoverWorkflows } from "./workflows.js";

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
  exitCode: number;
  messages: Message[];
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
  step?: number;
}

export interface WorkflowDetails {
  workflowName: string;
  workflowSource: WorkflowSource;
  workflowFilePath: string | null;
  results: SingleResult[];
}

export type WorkflowUpdate = WorkflowDetails;

export interface WorkflowRunResult {
  workflowName: string;
  workflowSource: WorkflowSource;
  workflowFilePath: string | null;
  results: SingleResult[];
  finalText: string;
  isError: boolean;
  errorMessage?: string;
}

export type WorkflowUpdateCallback = (details: WorkflowUpdate) => void;

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
    result.stopReason === "aborted"
  );
}

async function runSingleAgent(
  defaultCwd: string,
  agents: AgentConfig[],
  agentName: string,
  task: string,
  step: number,
  signal: AbortSignal | undefined,
  onUpdate: ((result: SingleResult) => void) | undefined,
): Promise<SingleResult> {
  const agent = agents.find((item) => item.name === agentName);
  if (!agent) {
    return {
      agent: agentName,
      agentSource: "unknown",
      task,
      exitCode: 1,
      messages: [],
      stderr: `Unknown agent: "${agentName}"`,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        cost: 0,
        contextTokens: 0,
        turns: 0,
      },
      step,
    };
  }

  const args: string[] = ["--mode", "json", "-p", "--no-session"];
  if (agent.model) args.push("--model", agent.model);
  if (agent.tools && agent.tools.length > 0) {
    args.push("--tools", agent.tools.join(","));
  }

  let tempPromptDir: string | null = null;
  let tempPromptPath: string | null = null;

  const currentResult: SingleResult = {
    agent: agentName,
    agentSource: agent.source,
    task,
    exitCode: 0,
    messages: [],
    stderr: "",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      cost: 0,
      contextTokens: 0,
      turns: 0,
    },
    model: agent.model,
    step,
  };

  const emitUpdate = () => {
    onUpdate?.({ ...currentResult, messages: [...currentResult.messages] });
  };

  try {
    if (agent.systemPrompt.trim()) {
      const tempPrompt = writePromptToTempFile(agent.name, agent.systemPrompt);
      tempPromptDir = tempPrompt.dir;
      tempPromptPath = tempPrompt.filePath;
      args.push("--append-system-prompt", tempPromptPath);
    }

    args.push(task);
    let wasAborted = false;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("pi", args, {
        cwd: defaultCwd,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try {
          event = JSON.parse(line);
        } catch {
          return;
        }

        if (event.type === "message_end" && event.message) {
          const message = event.message as Message;
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
            if (message.errorMessage) {
              currentResult.errorMessage = message.errorMessage;
            }
          }
          emitUpdate();
        }

        if (event.type === "tool_result_end" && event.message) {
          currentResult.messages.push(event.message as Message);
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

      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        resolve(code ?? 0);
      });

      proc.on("error", () => resolve(1));

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
  signal?: AbortSignal,
  onUpdate?: WorkflowUpdateCallback,
): Promise<WorkflowRunResult> {
  const { agents } = discoverAgents(cwd);
  const { workflows } = discoverWorkflows(cwd);
  const workflow = workflows.find((item) => item.name === workflowName);

  if (!workflow) {
    return {
      workflowName,
      workflowSource: "built-in",
      workflowFilePath: null,
      results: [],
      finalText: "",
      isError: true,
      errorMessage: `Unknown workflow: "${workflowName}"`,
    };
  }

  const makeDetails = (results: SingleResult[]): WorkflowDetails => ({
    workflowName: workflow.name,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    results,
  });

  const missingAgents = workflow.agentNames.filter(
    (agentName) => !agents.some((agent) => agent.name === agentName),
  );
  if (missingAgents.length > 0) {
    return {
      workflowName: workflow.name,
      workflowSource: workflow.source,
      workflowFilePath: workflow.filePath ?? null,
      results: [],
      finalText: "",
      isError: true,
      errorMessage: `Workflow "${workflow.name}" cannot start. Missing agents: ${missingAgents.join(", ")}.`,
    };
  }

  const results: SingleResult[] = [];
  let currentInput = task;

  for (let index = 0; index < workflow.agentNames.length; index++) {
    const agentName = workflow.agentNames[index];
    const result = await runSingleAgent(
      cwd,
      agents,
      agentName,
      currentInput,
      index + 1,
      signal,
      onUpdate
        ? (partialResult) => {
            onUpdate(makeDetails([...results, partialResult]));
          }
        : undefined,
    );
    results.push(result);

    if (isErrorResult(result)) {
      const errorMessage =
        result.errorMessage ||
        result.stderr ||
        getFinalOutput(result.messages) ||
        "(no output)";
      return {
        workflowName: workflow.name,
        workflowSource: workflow.source,
        workflowFilePath: workflow.filePath ?? null,
        results,
        finalText: "",
        isError: true,
        errorMessage: `Workflow stopped at step ${index + 1} (${agentName}): ${errorMessage}`,
      };
    }

    currentInput = getFinalOutput(result.messages);
  }

  return {
    workflowName: workflow.name,
    workflowSource: workflow.source,
    workflowFilePath: workflow.filePath ?? null,
    results,
    finalText:
      results.length > 0
        ? getFinalOutput(results[results.length - 1].messages) || "(no output)"
        : "(no output)",
    isError: false,
  };
}
