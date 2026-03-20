import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type AgentSource = "project" | "user" | "built-in";

interface AgentMatch {
  source: AgentSource;
  filePath: string;
}

const SOURCE_ORDER: readonly AgentSource[] = ["project", "user", "built-in"];
const EXTENSION_DIR = path.dirname(fileURLToPath(import.meta.url));

function normalizeAgentId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.md$/i, "")
    .replace(/[\s._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function findAgent(agentName: string, cwd: string): Promise<AgentMatch | undefined> {
  const normalizedId = normalizeAgentId(agentName);
  if (!normalizedId) return undefined;

  const candidates: Record<AgentSource, string> = {
    project: path.join(cwd, ".pi", "agents", `${normalizedId}.md`),
    user: path.join(os.homedir(), ".pi", "agent", "agents", `${normalizedId}.md`),
    "built-in": path.join(EXTENSION_DIR, "..", "agents", `${normalizedId}.md`),
  };

  for (const source of SOURCE_ORDER) {
    const filePath = candidates[source];
    if (await fileExists(filePath)) {
      return { source, filePath };
    }
  }

  return undefined;
}

function extractFrontmatter(content: string): string | undefined {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return undefined;
  return `---\n${match[1].trimEnd()}\n---`;
}

export default function (pi: ExtensionAPI) {
  pi.registerCommand("hello", {
    description: "Say hello or prefill an agent's frontmatter",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const agentName = args.trim();
      if (agentName) {
        const agent = await findAgent(agentName, ctx.cwd);
        if (!agent) {
          ctx.ui.notify(`No agent found for "${agentName}"`, "warning");
          return;
        }

        const content = await fs.readFile(agent.filePath, "utf8");
        const frontmatter = extractFrontmatter(content);
        if (!frontmatter) {
          ctx.ui.notify(`Agent "${agentName}" has no frontmatter`, "warning");
          return;
        }

        ctx.ui.setEditorText(frontmatter);
        ctx.ui.notify(`Frontmatter loaded from ${agent.source} agent`, "info");
        return;
      }

      ctx.ui.notify("Hello!", "info");
    },
  });
}
