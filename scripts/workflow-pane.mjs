import fs from "node:fs";
import readline from "node:readline/promises";
import { spawn, spawnSync } from "node:child_process";
import { stdin, stdout } from "node:process";
import createJiti from "@mariozechner/jiti";

const jiti = createJiti(import.meta.url);
const runtime = jiti("../src/workflow-runtime.ts");

const {
  runWorkflowByName,
  getFinalOutput,
  isErrorResult,
} = runtime;

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

function renderWorkflow(details, finalMessage) {
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

  return lines.join("\n");
}

function writeStatus(statusFile, payload) {
  if (!statusFile) return;
  fs.writeFileSync(statusFile, JSON.stringify(payload), "utf8");
}

async function promptToClosePane() {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  const answer = await rl.question(
    "Press Enter to close this pane, or type 'keep' to leave it open: ",
  );
  rl.close();

  const normalized = answer.trim().toLowerCase();
  if (!normalized || normalized === "y" || normalized === "yes") {
    spawnSync("zellij", ["action", "close-pane"], { stdio: "ignore" });
    return;
  }

  const shell = process.env.SHELL || "zsh";
  await new Promise((resolve) => {
    const proc = spawn(shell, ["-l"], { stdio: "inherit" });
    proc.on("exit", () => resolve());
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const workflowName = args.workflow;
  const task = args.task;
  const cwd = args.cwd || process.cwd();
  const statusFile = args["status-file"];

  if (!workflowName || !task) {
    console.error("Missing required args: --workflow and --task");
    process.exit(1);
  }

  const result = await runWorkflowByName(cwd, workflowName, task, undefined, (details) => {
    stdout.write("\x1bc");
    stdout.write(renderWorkflow(details));
  });

  stdout.write("\x1bc");
  stdout.write(
    renderWorkflow(
      {
        workflowName: result.workflowName,
        workflowSource: result.workflowSource,
        workflowFilePath: result.workflowFilePath,
        results: result.results,
      },
      result.isError ? result.errorMessage : result.finalText,
    ),
  );

  writeStatus(statusFile, {
    done: true,
    success: !result.isError,
    message: result.isError ? result.errorMessage : result.finalText,
  });

  if (stdin.isTTY && stdout.isTTY) {
    stdout.write("\n");
    await promptToClosePane();
  }
}

main().catch((error) => {
  const args = parseArgs(process.argv);
  writeStatus(args["status-file"], {
    done: true,
    success: false,
    message: error instanceof Error ? error.message : String(error),
  });
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});
