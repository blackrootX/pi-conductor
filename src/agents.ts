import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";

export type AgentSource = "built-in" | "global" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath?: string;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  globalAgentsDir: string;
}

const BUILT_IN_AGENTS: AgentConfig[] = [
  {
    name: "plan",
    description: "Planning specialist for the next workflow step",
    tools: ["read", "grep", "find", "ls"],
    source: "built-in",
    systemPrompt: [
      "You are the planning step in a coding workflow.",
      "Your job is to inspect the repository and turn the input into a concise implementation plan for the next agent.",
      "Be concrete and code-oriented.",
      "Do not modify files.",
      "Output plain text that another agent can directly execute.",
    ].join("\n"),
  },
  {
    name: "build",
    description: "Implementation specialist for workflow execution",
    tools: ["read", "write", "edit", "grep", "find", "ls", "bash"],
    source: "built-in",
    systemPrompt: [
      "You are the build step in a coding workflow.",
      "Treat the provided input as the implementation instructions from the previous workflow step.",
      "Inspect the repository, make the required changes, and explain what you completed.",
      "Prefer concrete execution over high-level planning.",
    ].join("\n"),
  },
];

function isDirectory(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function findNearestProjectAgentsDir(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "agents");
    if (isDirectory(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

function loadAgentsFromDir(
  dir: string,
  source: Exclude<AgentSource, "built-in">,
): AgentConfig[] {
  if (!fs.existsSync(dir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".md")) continue;
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;

    const filePath = path.join(dir, entry.name);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const { frontmatter, body } =
      parseFrontmatter<Record<string, string>>(content);
    if (!frontmatter.name || !frontmatter.description) continue;

    const tools = frontmatter.tools
      ?.split(/[,\s]+/)
      .map((tool) => tool.trim())
      .filter(Boolean);

    agents.push({
      name: frontmatter.name,
      description: frontmatter.description,
      tools: tools && tools.length > 0 ? tools : undefined,
      model: frontmatter.model,
      systemPrompt: body.trim(),
      source,
      filePath,
    });
  }

  return agents;
}

export function discoverAgents(cwd: string): AgentDiscoveryResult {
  const globalAgentsDir = path.join(getAgentDir(), "agents");
  const projectAgentsDir = findNearestProjectAgentsDir(cwd);
  const globalAgents = loadAgentsFromDir(globalAgentsDir, "global");
  const projectAgents = projectAgentsDir
    ? loadAgentsFromDir(projectAgentsDir, "project")
    : [];

  const agentMap = new Map<string, AgentConfig>();

  for (const agent of BUILT_IN_AGENTS) agentMap.set(agent.name, agent);
  for (const agent of globalAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    globalAgentsDir,
  };
}
