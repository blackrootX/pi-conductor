import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";
import type {
  WorkflowConfig,
  WorkflowSource,
  WorkflowStepConfig,
} from "./workflow-types.js";

export { type WorkflowConfig, type WorkflowSource, type WorkflowStepConfig } from "./workflow-types.js";

export const DEFAULT_WORKFLOW_NAME = "plan-build";

export interface WorkflowDiscoveryResult {
  workflows: WorkflowConfig[];
  projectWorkflowFile: string | null;
  globalWorkflowFile: string;
}

function normalizeWorkflowSteps(agentNames: string[]): WorkflowStepConfig[] {
  return agentNames.map((agent, index) => ({
    id: `step-${String(index + 1).padStart(2, "0")}`,
    agent,
  }));
}

const BUILT_IN_WORKFLOWS: WorkflowConfig[] = [
  {
    name: DEFAULT_WORKFLOW_NAME,
    steps: normalizeWorkflowSteps(["plan", "build"]),
    source: "built-in",
  },
];

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function findNearestProjectWorkflowFile(cwd: string): string | null {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "workflow.yaml");
    if (fileExists(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function normalizeWorkflowConfig(
  name: string,
  agentNames: string[],
  source: WorkflowSource,
  filePath?: string,
): WorkflowConfig | undefined {
  const normalizedAgentNames = agentNames.filter(
    (item): item is string => typeof item === "string" && item.trim().length > 0,
  );
  if (normalizedAgentNames.length === 0) return undefined;
  return {
    name,
    steps: normalizeWorkflowSteps(normalizedAgentNames),
    source,
    filePath,
  };
}

function loadWorkflowsFromFile(
  filePath: string,
  source: Exclude<WorkflowSource, "built-in">,
): WorkflowConfig[] {
  if (!fileExists(filePath)) return [];

  let content: string;
  try {
    content = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }

  let data: unknown;
  try {
    data = parseYaml(content);
  } catch {
    return [];
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) return [];

  const workflows: WorkflowConfig[] = [];
  for (const [name, value] of Object.entries(data)) {
    if (!name || !Array.isArray(value)) continue;
    const workflow = normalizeWorkflowConfig(name, value, source, filePath);
    if (workflow) workflows.push(workflow);
  }

  return workflows;
}

export function discoverWorkflows(cwd: string): WorkflowDiscoveryResult {
  const globalWorkflowFile = path.join(getAgentDir(), "workflow.yaml");
  const projectWorkflowFile = findNearestProjectWorkflowFile(cwd);
  const globalWorkflows = loadWorkflowsFromFile(globalWorkflowFile, "global");
  const projectWorkflows = projectWorkflowFile
    ? loadWorkflowsFromFile(projectWorkflowFile, "project")
    : [];

  const workflowMap = new Map<string, WorkflowConfig>();
  for (const workflow of BUILT_IN_WORKFLOWS) workflowMap.set(workflow.name, workflow);
  for (const workflow of globalWorkflows) workflowMap.set(workflow.name, workflow);
  for (const workflow of projectWorkflows) workflowMap.set(workflow.name, workflow);

  return {
    workflows: Array.from(workflowMap.values()),
    projectWorkflowFile,
    globalWorkflowFile,
  };
}
