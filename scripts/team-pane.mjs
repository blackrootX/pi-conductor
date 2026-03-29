import fs from "node:fs";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import createJiti from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const runtime = jiti("../src/team-runtime.ts");
const workflowRuntime = jiti("../src/workflow-runtime.ts");
const cards = jiti("../src/team-cards.ts");

const { runTeamByName } = runtime;
const { getFinalOutput } = workflowRuntime;
const { buildTeamCardPayload } = cards;
const { renderTeamCardLines } = cards;

let latestRenderState = null;
let animationTimer = null;
let currentStatusFile = undefined;
let currentAbortFile = undefined;
let currentDefaultModel = undefined;
let currentAbortController = null;
let abortRequested = false;
let forcedExitTimer = null;

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

function findMemberResult(details, phaseIndex, memberIndex) {
  return details.results.find(
    (result) => result.phaseIndex === phaseIndex && result.memberIndex === memberIndex,
  );
}

function renderTeam(details, finalMessage, isRunning = false, animationTick = Date.now()) {
  const lines = [];
  lines.push(`team: ${details.teamName} (${details.teamSource})`);
  if (details.teamFilePath) lines.push(`source: ${details.teamFilePath}`);
  if (details.runDir) lines.push(`run dir: ${details.runDir}`);
  lines.push("");

  for (let phaseIndex = 0; phaseIndex < details.phases.length; phaseIndex++) {
    const phase = details.phases[phaseIndex];
    lines.push(`phase ${phaseIndex + 1}: ${phase.kind}`);
    if (phase.warningMessage) lines.push(`  warning: ${phase.warningMessage}`);

    for (let memberIndex = 0; memberIndex < phase.members.length; memberIndex++) {
      const memberState = phase.members[memberIndex];
      const result = findMemberResult(details, phaseIndex, memberIndex);
      const isError = memberState.status === "error";
      const icon = isError ? "[x]" : memberState.status === "done" ? "[✓]" : "[ ]";
      lines.push(`${icon} ${memberState.agent}`);

      if (result) {
        lines.push(`  input: ${result.task}`);
        const assistantMessages = result.messages.filter((message) => message.role === "assistant");
        const latestMessage = assistantMessages[assistantMessages.length - 1];
        if (latestMessage) {
          for (const part of latestMessage.content) {
            if (part.type === "toolCall") {
              lines.push(`  -> ${part.name} ${JSON.stringify(part.arguments)}`);
            }
          }
        }

        const finalOutput = getFinalOutput(result.messages).trim();
        if (finalOutput) {
          for (const line of finalOutput.split("\n").slice(0, 8)) {
            lines.push(`  ${line}`);
          }
        }
      } else if (memberState.lastWork.trim()) {
        lines.push(`  ${memberState.lastWork.trim()}`);
      } else {
        lines.push(`  (${memberState.status})`);
      }
    }

    lines.push("");
  }

  if (finalMessage) {
    lines.push(finalMessage);
    lines.push("");
  }

  lines.push(
    ...renderTeamCardLines(
      buildTeamCardPayload(details),
      stdout.columns || 100,
      undefined,
      { animationTick },
    ),
  );
  return lines.join("\n");
}

function redraw() {
  if (!latestRenderState) return;
  stdout.write("\x1bc");
  stdout.write(
    renderTeam(
      latestRenderState.details,
      latestRenderState.finalMessage,
      latestRenderState.isRunning,
      Date.now(),
    ),
  );
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

function buildTeamSummary(details, finalMessage, isRunning) {
  const completedPhases = details.phases.filter((phase) =>
    phase.members.every((member) => member.status === "done"),
  ).length;
  const activePhaseIndex = details.phases.findIndex((phase) =>
    phase.members.some((member) => member.status === "running"),
  );
  const parts = [];

  if (completedPhases > 0) {
    parts.push(`Completed phases: ${completedPhases}`);
  }
  if (isRunning && activePhaseIndex >= 0) {
    parts.push(`Active phase: ${activePhaseIndex + 1}`);
  }

  const latestResult = details.results[details.results.length - 1];
  const output = truncateSummary(
    finalMessage || (latestResult ? getFinalOutput(latestResult.messages) : ""),
  );
  if (output) parts.push(output);

  return parts.join("\n\n");
}

function writeCurrentStatus(overrides = {}) {
  if (!currentStatusFile || !latestRenderState) return;

  writeStatus(currentStatusFile, {
    done: true,
    success: false,
    message: latestRenderState.finalMessage || "Team pane was closed.",
    summary: buildTeamSummary(
      latestRenderState.details,
      latestRenderState.finalMessage,
      latestRenderState.isRunning,
    ),
    closedByUser: true,
    runDir: latestRenderState.details.runDir,
    ...overrides,
  });
}

function requestAbort() {
  if (abortRequested) return;
  abortRequested = true;

  if (currentAbortFile) {
    try {
      fs.unlinkSync(currentAbortFile);
    } catch {
      /* ignore */
    }
  }

  if (currentAbortController && !currentAbortController.signal.aborted) {
    currentAbortController.abort();
  }

  if (!forcedExitTimer) {
    forcedExitTimer = setTimeout(() => {
      writeCurrentStatus();
      process.exit(0);
    }, 5000);
  }
}

function pollAbortSentinel() {
  if (!currentAbortFile || abortRequested) return;
  try {
    if (fs.existsSync(currentAbortFile)) requestAbort();
  } catch {
    /* ignore */
  }
}

function setAnimationRunning(shouldAnimate) {
  if (shouldAnimate) {
    if (animationTimer) return;
    animationTimer = setInterval(() => {
      pollAbortSentinel();
      redraw();
    }, 250);
    return;
  }

  if (animationTimer) {
    clearInterval(animationTimer);
    animationTimer = null;
  }
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

  spawnSync("tmux", ["kill-pane"], { stdio: "ignore" });
}

async function main() {
  const args = parseArgs(process.argv);
  const teamName = args.team;
  const task = args.task;
  const cwd = args.cwd || process.cwd();
  const defaultModel = args["default-model"] || undefined;
  const progressFile = args["progress-file"];
  const statusFile = args["status-file"];
  const abortFile = args["abort-file"];

  if (!teamName || !task) {
    console.error("Missing required args: --team and --task");
    process.exit(1);
  }

  currentStatusFile = statusFile;
  currentAbortFile = abortFile;
  currentDefaultModel = defaultModel;
  currentAbortController = new AbortController();

  const result = await runTeamByName(
    cwd,
    teamName,
    task,
    defaultModel,
    currentAbortController.signal,
    (details) => {
      writeStatus(progressFile, buildTeamCardPayload(details));
      latestRenderState = { details, finalMessage: undefined, isRunning: true };
      setAnimationRunning(true);
      redraw();
    },
  );

  if (forcedExitTimer) clearTimeout(forcedExitTimer);

  writeStatus(progressFile, buildTeamCardPayload(result));
  latestRenderState = {
    details: result,
    finalMessage: abortRequested
      ? result.errorMessage || "Team pane was closed."
      : result.isError
        ? result.errorMessage
        : result.finalText,
    isRunning: false,
  };
  setAnimationRunning(false);
  redraw();

  writeStatus(statusFile, {
    done: true,
    success: !result.isError && !abortRequested,
    message: abortRequested
      ? result.errorMessage || "Team pane was closed."
      : result.isError
        ? result.errorMessage
        : result.finalText,
    summary: buildTeamSummary(
      latestRenderState.details,
      latestRenderState.finalMessage,
      false,
    ),
    closedByUser: abortRequested,
    runDir: result.runDir,
  });

  if (stdin.isTTY && stdout.isTTY && !abortRequested) {
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
    closedByUser: abortRequested,
    runDir: latestRenderState?.details?.runDir,
  });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

process.on("SIGTERM", requestAbort);
process.on("SIGHUP", requestAbort);
process.on("SIGINT", requestAbort);
