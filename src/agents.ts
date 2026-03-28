import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { composeBuiltInPrompt } from "./workflow-prompt-composer.js";
import type { ExecutionProfile, WorkflowStepConfig } from "./workflow-types.js";

export type AgentSource = "built-in" | "global" | "project";

export interface AgentConfig {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  source: AgentSource;
  filePath?: string;
  internalIncludes?: string[];
  rolePrompt?: string;
  defaultProfile?: ExecutionProfile;
}

export interface AgentDiscoveryResult {
  agents: AgentConfig[];
  projectAgentsDir: string | null;
  globalAgentsDir: string;
}

export type RuntimeToolClass =
  | "read-only"
  | "write-capable"
  | "unspecified";

export interface ExecutionProfileResolution {
  baseProfile: ExecutionProfile;
  resolvedProfile: ExecutionProfile;
}

type BuiltInAgentDefinition = Omit<AgentConfig, "systemPrompt"> & {
  internalIncludes: string[];
  rolePrompt: string;
};

const BUILT_IN_AGENTS: BuiltInAgentDefinition[] = [
  {
    name: "plan",
    description: "Planning specialist for the next workflow step",
    tools: ["read", "grep", "find", "ls"],
    source: "built-in",
    internalIncludes: [
      "workflow-role-common",
      "done-criteria",
      "evidence-style",
      "verify-style",
    ],
    defaultProfile: "planning",
    rolePrompt: [
      "You are the planning step in a coding workflow.",
      "Be concrete and code-oriented while staying strictly in planning mode.",
    ].join("\n"),
  },
  {
    name: "build",
    description: "Implementation specialist for workflow execution",
    tools: ["read", "write", "edit", "grep", "find", "ls", "bash"],
    source: "built-in",
    internalIncludes: [
      "workflow-role-common",
      "done-criteria",
      "evidence-style",
      "verify-style",
    ],
    defaultProfile: "implement",
    rolePrompt: [
      "You are the build step in a coding workflow.",
      "Treat the provided context as the current workflow state and execute the required implementation work.",
    ].join("\n"),
  },
];

function getBuiltInAgents(): AgentConfig[] {
  return BUILT_IN_AGENTS.map(({ rolePrompt, internalIncludes, ...agent }) => ({
    ...agent,
    internalIncludes: [...internalIncludes],
    rolePrompt,
    systemPrompt: composeBuiltInPrompt(rolePrompt, internalIncludes, agent.defaultProfile),
  }));
}

export function getAgentToolClass(
  agent: AgentConfig | undefined,
): RuntimeToolClass {
  const tools = agent?.tools ?? [];
  if (tools.length === 0) return "unspecified";
  return tools.some((tool) => tool === "write" || tool === "edit" || tool === "bash")
    ? "write-capable"
    : "read-only";
}

function inferBaseExecutionProfile(
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
): ExecutionProfile {
  if (step.agent === "plan" || agent?.defaultProfile === "planning") {
    return "planning";
  }
  if (step.agent === "build" || agent?.defaultProfile === "implement") {
    return "implement";
  }

  const toolClass = getAgentToolClass(agent);
  if (toolClass === "read-only") return "explore";
  if (toolClass === "write-capable") return "implement";

  return agent?.source === "built-in" ? "implement" : "explore";
}

function resolveProfilePolicy(
  baseProfile: ExecutionProfile,
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
): ExecutionProfile {
  const normalizedStepId = step.id.trim().toLowerCase();
  const toolClass = getAgentToolClass(agent);

  if (
    baseProfile === "implement" &&
    toolClass === "write-capable" &&
    (normalizedStepId.includes("verify") ||
      normalizedStepId.includes("evidence") ||
      normalizedStepId.includes("context"))
  ) {
    return "verify-context";
  }

  return baseProfile;
}

export function resolveExecutionProfile(
  step: WorkflowStepConfig,
  agent: AgentConfig | undefined,
): ExecutionProfileResolution {
  const baseProfile = inferBaseExecutionProfile(step, agent);
  const resolvedProfile = resolveProfilePolicy(baseProfile, step, agent);
  return { baseProfile, resolvedProfile };
}

export function resolveAgentSystemPrompt(
  agent: AgentConfig,
  profile: ExecutionProfile,
): string {
  if (agent.source !== "built-in" || !agent.rolePrompt || !agent.internalIncludes) {
    return agent.systemPrompt;
  }
  return composeBuiltInPrompt(agent.rolePrompt, agent.internalIncludes, profile);
}

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

  for (const agent of getBuiltInAgents()) agentMap.set(agent.name, agent);
  for (const agent of globalAgents) agentMap.set(agent.name, agent);
  for (const agent of projectAgents) agentMap.set(agent.name, agent);

  return {
    agents: Array.from(agentMap.values()),
    projectAgentsDir,
    globalAgentsDir,
  };
}
