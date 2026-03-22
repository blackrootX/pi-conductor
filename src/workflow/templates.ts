import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
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

type WorkflowYamlTemplateValue =
  | string[]
  | {
      description?: string;
      agents?: string[];
    };

function getUserWorkflowTemplatesPath(): string {
  return path.join(os.homedir(), ".pi", "workflows.json");
}

function getProjectWorkflowTemplatesPath(cwd = process.cwd()): string {
  return path.join(cwd, ".pi", "workflows.json");
}

function getUserWorkflowYamlTemplatesPath(): string {
  return path.join(os.homedir(), ".pi", "workflows.yaml");
}

function getProjectWorkflowYamlTemplatesPath(cwd = process.cwd()): string {
  return path.join(cwd, ".pi", "workflows.yaml");
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

async function readWorkflowYamlTemplateMap(filePath: string): Promise<Record<string, WorkflowYamlTemplateValue>> {
  try {
    const content = await fs.readFile(filePath, "utf8");
    const parsed = parseDocument(content).toJSON() as Record<string, WorkflowYamlTemplateValue> | null;

    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return parsed;
  } catch {
    return {};
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.trim().length > 0);
}

function createWorkflowFromAgentList(
  workflowId: string,
  template: WorkflowYamlTemplateValue
): WorkflowSpec | undefined {
  const description = typeof template === "object" && !Array.isArray(template)
    ? template.description
    : undefined;
  const agents = Array.isArray(template)
    ? template
    : template?.agents;

  if (!isStringArray(agents) || agents.length === 0) {
    return undefined;
  }

  const seenStepIds = new Map<string, number>();
  let previousStepId: string | undefined;
  const steps = agents.map((agentId, index) => {
    const normalizedAgentId = agentId.trim();
    const baseStepId = normalizedAgentId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || `step-${index + 1}`;
    const duplicateCount = seenStepIds.get(baseStepId) ?? 0;
    seenStepIds.set(baseStepId, duplicateCount + 1);
    const stepId = duplicateCount === 0 ? baseStepId : `${baseStepId}-${duplicateCount + 1}`;
    const step = {
      id: stepId,
      title: `Run ${normalizedAgentId}`,
      prompt: index === 0
        ? "Start the workflow by handling the user task from your specialist perspective."
        : "Continue the workflow using the previous steps as context and contribute your specialist work.",
      dependsOn: previousStepId ? [previousStepId] : [],
      agentId: normalizedAgentId,
    };
    previousStepId = stepId;

    return step;
  });

  return {
    id: workflowId,
    name: humanizeWorkflowId(workflowId),
    description,
    steps,
    policy: {
      maxParallelism: 1,
      onStepFailure: "abort",
    },
    synthesis: {
      strategy: "lead",
    },
  };
}

function humanizeWorkflowId(workflowId: string): string {
  return workflowId
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function readWorkflowYamlTemplateFile(filePath: string): Promise<WorkflowSpec[]> {
  const parsed = await readWorkflowYamlTemplateMap(filePath);
  return Object.entries(parsed)
    .map(([workflowId, template]) => createWorkflowFromAgentList(workflowId, template))
    .filter((workflow): workflow is WorkflowSpec => Boolean(workflow));
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
  const userYamlWorkflows = await readWorkflowYamlTemplateFile(getUserWorkflowYamlTemplatesPath());
  const projectYamlWorkflows = await readWorkflowYamlTemplateFile(getProjectWorkflowYamlTemplatesPath(cwd));

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

  for (const workflow of userYamlWorkflows) {
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

  for (const workflow of projectYamlWorkflows) {
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

export async function saveWorkflowAgentListTemplate(
  workflowId: string,
  agentIds: string[],
  scope: "project" | "user",
  cwd = process.cwd(),
  description?: string,
  overwrite = false
): Promise<void> {
  const filePath = scope === "project"
    ? getProjectWorkflowYamlTemplatesPath(cwd)
    : getUserWorkflowYamlTemplatesPath();
  const existing = await readWorkflowYamlTemplateMap(filePath);

  if (existing[workflowId] && !overwrite) {
    throw new Error(`Workflow template already exists: ${workflowId}`);
  }

  existing[workflowId] = description
    ? { description, agents: agentIds }
    : agentIds;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringify(existing), "utf8");
}

export async function removeWorkflowTemplate(
  workflowId: string,
  source: WorkflowTemplateSource,
  cwd = process.cwd()
): Promise<void> {
  if (source === "built-in") {
    throw new Error(`Cannot remove built-in workflow: ${workflowId}`);
  }

  const jsonPath = source === "project"
    ? getProjectWorkflowTemplatesPath(cwd)
    : getUserWorkflowTemplatesPath();
  const yamlPath = source === "project"
    ? getProjectWorkflowYamlTemplatesPath(cwd)
    : getUserWorkflowYamlTemplatesPath();

  const existingJson = await readWorkflowTemplateFile(jsonPath);
  const nextJson = existingJson.filter((workflow) => workflow.id !== workflowId);
  if (nextJson.length !== existingJson.length) {
    await writeWorkflowTemplateFile(jsonPath, nextJson);
  }

  const existingYaml = await readWorkflowYamlTemplateMap(yamlPath);
  if (workflowId in existingYaml) {
    delete existingYaml[workflowId];
    await fs.mkdir(path.dirname(yamlPath), { recursive: true });
    await fs.writeFile(yamlPath, stringify(existingYaml), "utf8");
  }
}
