import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { parse as parseYaml } from "yaml";

export const DEFAULT_WORKFLOW_NAME = "plan-build";

export type WorkflowSource = "built-in" | "global" | "project";

export interface WorkflowConfig {
  name: string;
  agentNames: string[];
  source: WorkflowSource;
  filePath?: string;
}

export interface WorkflowDiscoveryResult {
  workflows: WorkflowConfig[];
  projectWorkflowFile: string | null;
  globalWorkflowFile: string;
}

const BUILT_IN_WORKFLOWS: WorkflowConfig[] = [
  {
    name: DEFAULT_WORKFLOW_NAME,
    agentNames: ["plan", "build"],
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
    const agentNames = value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
    if (agentNames.length === 0) continue;
    workflows.push({
      name,
      agentNames,
      source,
      filePath,
    });
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
