import fs from "node:fs";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import createJiti from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const runtime = jiti("../src/workflow-runtime.ts");
const cards = jiti("../src/workflow-cards.ts");

const {
  runWorkflowByName,
  getFinalOutput,
  isErrorResult,
} = runtime;
const { buildWorkflowCardPayload, renderWorkflowCardLines } = cards;

let latestRenderState = null;
let animationTimer = null;
let currentDefaultModel = undefined;
let currentStatusFile = undefined;
let closingHandled = false;

function parseArgs(argv) {
  const args = {};
  for (let index = 2; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--")) continue;
    args[key.slice(2)] = value;
  }
  return args;
}

function renderWorkflow(details, finalMessage, isRunning = false, animationTick = Date.now()) {
  const lines = [];
  lines.push(`workflow: ${details.workflowName} (${details.workflowSource})`);
  if (details.workflowFilePath) lines.push(`source: ${details.workflowFilePath}`);
  lines.push("");

  for (const result of details.results) {
    const icon = isErrorResult(result) ? "[x]" : "[✓]";
    lines.push(`${icon} step ${result.step}: ${result.agent} (${result.agentSource})`);
    lines.push(`input: ${result.task}`);

    const assistantMessages = result.messages.filter((message) => message.role === "assistant");
    const latestMessage = assistantMessages[assistantMessages.length - 1];
    if (latestMessage) {
      for (const part of latestMessage.content) {
        if (part.type === "toolCall") {
          const preview = JSON.stringify(part.arguments);
          lines.push(`  -> ${part.name} ${preview}`);
        }
      }
      const finalOutput = getFinalOutput(result.messages);
      if (finalOutput) {
        const preview = finalOutput.split("\n").slice(0, 8);
        for (const line of preview) {
          lines.push(`  ${line}`);
        }
      }
    } else {
      lines.push("  (running...)");
    }
    lines.push("");
  }

  if (finalMessage) {
    lines.push(finalMessage);
    lines.push("");
  }

  const payload = buildWorkflowCardPayload(details, isRunning, currentDefaultModel);
  lines.push(
    ...renderWorkflowCardLines(payload, stdout.columns || 100, undefined, {
      animationTick,
    }),
  );

  return lines.join("\n");
}

function redraw() {
  if (!latestRenderState) return;
  stdout.write("\x1bc");
  stdout.write(
    renderWorkflow(
      latestRenderState.details,
      latestRenderState.finalMessage,
      latestRenderState.isRunning,
      Date.now(),
    ),
  );
}

function setAnimationRunning(shouldAnimate) {
  if (shouldAnimate) {
    if (animationTimer) return;
    animationTimer = setInterval(() => {
      redraw();
    }, 250);
    return;
  }

  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
}

function writeStatus(statusFile, payload) {
  if (!statusFile) return;
  fs.writeFileSync(statusFile, JSON.stringify(payload), "utf8");
}

function truncateSummary(text, maxLength = 1200) {
  const normalized = text.trim();
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function buildWorkflowSummary(details, finalMessage, isRunning) {
  const completedSteps = details.results
    .filter((result) => !isErrorResult(result))
    .map((result) => result.agent);
  const latestStep = details.results[details.results.length - 1];
  const parts = [];

  if (completedSteps.length > 0) {
    parts.push(`Completed: ${completedSteps.join(" -> ")}`);
  }

  if (isRunning && latestStep) {
    parts.push(`Active: ${latestStep.agent}`);
  }

  const output =
    truncateSummary(finalMessage || (latestStep ? getFinalOutput(latestStep.messages) : ""));
  if (output) parts.push(output);

  return parts.join("\n\n");
}

function writeCurrentStatus(overrides = {}) {
  if (!currentStatusFile || !latestRenderState) return;

  const summary = buildWorkflowSummary(
    latestRenderState.details,
    latestRenderState.finalMessage,
    latestRenderState.isRunning,
  );

  writeStatus(currentStatusFile, {
    done: true,
    success: false,
    message: latestRenderState.finalMessage || "Workflow pane was closed.",
    summary,
    closedByUser: true,
    ...overrides,
  });
}

function handlePaneCloseSignal() {
  if (closingHandled) return;
  closingHandled = true;
  setAnimationRunning(false);
  writeCurrentStatus();
  process.exit(0);
}

async function promptToClosePane() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    "Press Enter or y to close this pane, or n to leave it open: ",
  );
  rl.close();

  const normalized = answer.trim().toLowerCase();
  if (normalized === "n" || normalized === "no" || normalized === "keep") {
    const shell = process.env.SHELL || "zsh";
    await new Promise((resolve) => {
      const proc = spawn(shell, ["-l"], { stdio: "inherit" });
      proc.on("exit", () => resolve());
    });
    return;
  }

  spawnSync("zellij", ["action", "close-pane"], { stdio: "ignore" });
}

async function main() {
  const args = parseArgs(process.argv);
  const workflowName = args.workflow;
  const task = args.task;
  const cwd = args.cwd || process.cwd();
  const defaultModel = args["default-model"] || undefined;
  currentDefaultModel = defaultModel;
  const progressFile = args["progress-file"];
  const statusFile = args["status-file"];
  currentStatusFile = statusFile;

  if (!workflowName || !task) {
    console.error("Missing required args: --workflow and --task");
    process.exit(1);
  }

  const result = await runWorkflowByName(cwd, workflowName, task, defaultModel, undefined, (details) => {
    writeStatus(progressFile, buildWorkflowCardPayload(details, true, defaultModel));
    latestRenderState = { details, finalMessage: undefined, isRunning: true };
    setAnimationRunning(true);
    redraw();
  });

  writeStatus(
    progressFile,
    buildWorkflowCardPayload(
      {
        workflowName: result.workflowName,
        agentNames: result.agentNames,
        workflowSource: result.workflowSource,
        workflowFilePath: result.workflowFilePath,
        results: result.results,
      },
      false,
      defaultModel,
    ),
  );
  latestRenderState = {
    details: {
      workflowName: result.workflowName,
      agentNames: result.agentNames,
      workflowSource: result.workflowSource,
      workflowFilePath: result.workflowFilePath,
      results: result.results,
    },
    finalMessage: result.isError ? result.errorMessage : result.finalText,
    isRunning: false,
  };
  setAnimationRunning(false);
  redraw();

  writeStatus(statusFile, {
    done: true,
    success: !result.isError,
    message: result.isError ? result.errorMessage : result.finalText,
    summary: buildWorkflowSummary(
      latestRenderState.details,
      latestRenderState.finalMessage,
      false,
    ),
  });
  closingHandled = true;

  if (stdin.isTTY && stdout.isTTY) {
    stdout.write("\n");
    await promptToClosePane();
  }
}

main().catch((error) => {
  setAnimationRunning(false);
  const args = parseArgs(process.argv);
  writeStatus(args["status-file"], {
    done: true,
    success: false,
    message: error instanceof Error ? error.message : String(error),
    summary: truncateSummary(error instanceof Error ? error.message : String(error)),
  });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

process.on("SIGTERM", handlePaneCloseSignal);
process.on("SIGHUP", handlePaneCloseSignal);
process.on("SIGINT", handlePaneCloseSignal);
