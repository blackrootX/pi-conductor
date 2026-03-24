import fs from "node:fs";
import { stdout } from "node:process";

let latestRawState = "";
let latestState = null;

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

function readState(stateFile, fallbackTitle) {
  try {
    const raw = fs.readFileSync(stateFile, "utf8");
    if (raw === latestRawState && latestState) return latestState;
    latestRawState = raw;
    latestState = JSON.parse(raw);
    return latestState;
  } catch {
    return {
      title: fallbackTitle,
      teamName: fallbackTitle,
      status: "pending",
      elapsedMs: 0,
      lastWork: "",
      input: "",
      done: false,
    };
  }
}

function truncate(text, maxLength = 160) {
  const normalized = (text || "").trim().replace(/\s+/g, " ");
  if (!normalized) return "";
  return normalized.length > maxLength
    ? `${normalized.slice(0, maxLength - 3)}...`
    : normalized;
}

function renderState(state) {
  const lines = [];
  const title = state.title || "team worker";
  lines.push(title);
  lines.push("=".repeat(title.length));
  lines.push("");

  if (typeof state.phaseIndex === "number") {
    lines.push(`Phase: ${state.phaseIndex + 1}${state.phaseKind ? ` (${state.phaseKind})` : ""}`);
  } else {
    lines.push("Phase: waiting");
  }

  lines.push(`Status: ${state.status || "pending"}`);
  if (state.agent) lines.push(`Agent: ${state.agent}`);
  if (state.model) lines.push(`Model: ${state.model}`);
  if (typeof state.elapsedMs === "number") {
    lines.push(`Elapsed: ${Math.max(0, Math.round(state.elapsedMs / 1000))}s`);
  }

  if (state.input) {
    lines.push("");
    lines.push("Input:");
    lines.push(truncate(state.input, 240));
  }

  if (state.lastWork) {
    lines.push("");
    lines.push("Latest:");
    lines.push(truncate(state.lastWork, 400));
  }

  if (state.finalMessage) {
    lines.push("");
    lines.push(state.done ? "Final:" : "Message:");
    lines.push(truncate(state.finalMessage, 400));
  }

  if (state.done) {
    lines.push("");
    lines.push("Done. Close this pane when finished reviewing it.");
  }

  return lines.join("\n");
}

function redraw(stateFile, fallbackTitle) {
  const state = readState(stateFile, fallbackTitle);
  stdout.write("\x1bc");
  stdout.write(renderState(state));
}

const args = parseArgs(process.argv);
const stateFile = args["state-file"];
const title = args.title || "team worker";

if (!stateFile) {
  console.error("Missing required arg: --state-file");
  process.exit(1);
}

redraw(stateFile, title);
setInterval(() => {
  redraw(stateFile, title);
}, 250);
