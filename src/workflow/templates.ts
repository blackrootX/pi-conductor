import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { WORKFLOW_PRESETS } from "./presets";
import type { WorkflowSpec } from "./types";

export type WorkflowTemplateSource = "built-in" | "project" | "user";

export interface WorkflowTemplateEntry {
  workflow: WorkflowSpec;
  source: WorkflowTemplateSource;
}

interface WorkflowTemplateFile {
  workflows?: WorkflowSpec[];
}

function getUserWorkflowTemplatesPath(): string {
  return path.join(os.homedir(), ".pi", "workflows.json");
}

function getProjectWorkflowTemplatesPath(cwd = process.cwd()): string {
  return path.join(cwd, ".pi", "workflows.json");
}

function isWorkflowSpec(value: unknown): value is WorkflowSpec {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkflowSpec>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.name === "string" &&
    Array.isArray(candidate.steps)
  );
}

async function readWorkflowTemplateFile(filePath: string): Promise<WorkflowSpec[]> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(content) as WorkflowTemplateFile | WorkflowSpec[];

    if (Array.isArray(parsed)) {
      return parsed.filter(isWorkflowSpec);
    }

    if (parsed && Array.isArray(parsed.workflows)) {
      return parsed.workflows.filter(isWorkflowSpec);
    }

    return [];
  } catch {
    return [];
  }
}

async function writeWorkflowTemplateFile(filePath: string, workflows: WorkflowSpec[]): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify({ workflows }, null, 2) + "\n", "utf8");
}

export async function listWorkflowDefinitions(
  cwd = process.cwd()
): Promise<Array<{ id: string; name: string; description?: string; source: WorkflowTemplateSource }>> {
  const entries = await getAvailableWorkflowMap(cwd);
  return Object.values(entries).map(({ workflow, source }) => ({
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    source,
  }));
}

export async function getWorkflowDefinition(
  id: string,
  cwd = process.cwd()
): Promise<WorkflowTemplateEntry | undefined> {
  const entries = await getAvailableWorkflowMap(cwd);
  return entries[id];
}

export async function getAvailableWorkflowMap(
  cwd = process.cwd()
): Promise<Record<string, WorkflowTemplateEntry>> {
  const userWorkflows = await readWorkflowTemplateFile(getUserWorkflowTemplatesPath());
  const projectWorkflows = await readWorkflowTemplateFile(getProjectWorkflowTemplatesPath(cwd));

  const merged: Record<string, WorkflowTemplateEntry> = {};

  for (const workflow of Object.values(WORKFLOW_PRESETS)) {
    merged[workflow.id] = {
      workflow,
      source: "built-in",
    };
  }

  for (const workflow of userWorkflows) {
    merged[workflow.id] = {
      workflow,
      source: "user",
    };
  }

  for (const workflow of projectWorkflows) {
    merged[workflow.id] = {
      workflow,
      source: "project",
    };
  }

  return merged;
}

export async function saveWorkflowTemplate(
  workflow: WorkflowSpec,
  scope: "project" | "user",
  cwd = process.cwd(),
  overwrite = false
): Promise<void> {
  const filePath = scope === "project"
    ? getProjectWorkflowTemplatesPath(cwd)
    : getUserWorkflowTemplatesPath();
  const existing = await readWorkflowTemplateFile(filePath);
  const existingIndex = existing.findIndex((entry) => entry.id === workflow.id);

  if (existingIndex >= 0 && !overwrite) {
    throw new Error(`Workflow template already exists: ${workflow.id}`);
  }

  const next = [...existing];
  if (existingIndex >= 0) {
    next[existingIndex] = workflow;
  } else {
    next.push(workflow);
  }

  await writeWorkflowTemplateFile(filePath, next);
}
