// src/workflow/presets.ts - Built-in workflow presets

import type { WorkflowSpec } from "./types";

// ============================================================================
// Preset Workflows
// ============================================================================

/**
 * Sequential workflow: plan → implement → review
 * Best for: feature development with quality gates
 */
export const PLAN_IMPLEMENT_REVIEW: WorkflowSpec = {
  id: "plan-implement-review",
  name: "Plan → Implement → Review",
  description: "Sequential workflow: plan the implementation, implement it, then review the result",
  steps: [
    {
      id: "plan",
      title: "Plan Implementation",
      prompt: "Analyze the task and create a detailed implementation plan.",
      dependsOn: [],
      role: "planner",
    },
    {
      id: "implement",
      title: "Implement Code",
      prompt: "Implement the code based on the plan.",
      dependsOn: ["plan"],
      role: "coder",
    },
    {
      id: "review",
      title: "Review Implementation",
      prompt: "Review the implementation and provide feedback.",
      dependsOn: ["implement"],
      role: "reviewer",
    },
  ],
  policy: {
    maxParallelism: 1,
    onStepFailure: "abort",
  },
  synthesis: {
    strategy: "lead",
  },
};

/**
 * Parallel audit workflow: audit multiple areas simultaneously
 * Best for: security reviews, code quality checks
 */
export const PARALLEL_AUDIT: WorkflowSpec = {
  id: "parallel-audit",
  name: "Parallel Audit",
  description: "Audit backend, frontend, tests, and docs in parallel",
  steps: [
    {
      id: "backend-audit",
      title: "Audit Backend Code",
      prompt: "Review backend code for quality, security, and best practices.",
      dependsOn: [],
      capability: "code-review",
    },
    {
      id: "frontend-audit",
      title: "Audit Frontend Code",
      prompt: "Review frontend code for quality, accessibility, and best practices.",
      dependsOn: [],
      capability: "code-review",
    },
    {
      id: "test-audit",
      title: "Audit Test Coverage",
      prompt: "Review test coverage and quality.",
      dependsOn: [],
      capability: "code-review",
    },
    {
      id: "docs-audit",
      title: "Audit Documentation",
      prompt: "Review documentation for completeness and accuracy.",
      dependsOn: [],
      capability: "code-review",
    },
  ],
  policy: {
    maxParallelism: 4,
    onStepFailure: "continue",
  },
  synthesis: {
    strategy: "concise",
  },
};

/**
 * Implement and review workflow: code → review
 * Best for: quick iterations on code changes
 */
export const IMPLEMENT_AND_REVIEW: WorkflowSpec = {
  id: "implement-and-review",
  name: "Implement → Review",
  description: "Simple workflow: implement code and review it",
  steps: [
    {
      id: "implement",
      title: "Implement Code",
      prompt: "Implement the requested code changes.",
      dependsOn: [],
      role: "coder",
    },
    {
      id: "review",
      title: "Review Implementation",
      prompt: "Review the implementation and provide detailed feedback.",
      dependsOn: ["implement"],
      role: "reviewer",
    },
  ],
  policy: {
    maxParallelism: 1,
    onStepFailure: "abort",
  },
  synthesis: {
    strategy: "all",
  },
};

/**
 * Research and write workflow
 * Best for: documentation, blog posts, technical writing
 */
export const RESEARCH_AND_WRITE: WorkflowSpec = {
  id: "research-and-write",
  name: "Research → Write",
  description: "Research a topic then write about it",
  steps: [
    {
      id: "research",
      title: "Research Topic",
      prompt: "Research the topic and gather key information.",
      dependsOn: [],
      capability: "task-analysis",
    },
    {
      id: "write",
      title: "Write Content",
      prompt: "Write the content based on research findings.",
      dependsOn: ["research"],
      role: "coder", // Using coder as a general writer
    },
  ],
  policy: {
    maxParallelism: 1,
    onStepFailure: "abort",
  },
  synthesis: {
    strategy: "lead",
  },
};

/**
 * Quick review workflow (single agent)
 * Best for: fast feedback on simple changes
 */
export const QUICK_REVIEW: WorkflowSpec = {
  id: "quick-review",
  name: "Quick Review",
  description: "Single-agent quick review",
  steps: [
    {
      id: "review",
      title: "Review",
      prompt: "Review the provided work and provide feedback.",
      dependsOn: [],
      role: "reviewer",
    },
  ],
  policy: {
    maxParallelism: 1,
    onStepFailure: "abort",
  },
  synthesis: {
    strategy: "lead",
  },
};

/**
 * All available presets
 */
export const WORKFLOW_PRESETS: Record<string, WorkflowSpec> = {
  "plan-implement-review": PLAN_IMPLEMENT_REVIEW,
  "parallel-audit": PARALLEL_AUDIT,
  "implement-and-review": IMPLEMENT_AND_REVIEW,
  "research-and-write": RESEARCH_AND_WRITE,
  "quick-review": QUICK_REVIEW,
};

/**
 * Get a workflow preset by ID
 */
export function getPreset(id: string): WorkflowSpec | undefined {
  return WORKFLOW_PRESETS[id];
}

/**
 * List all available presets
 */
export function listPresets(): Array<{ id: string; name: string; description?: string }> {
  return Object.values(WORKFLOW_PRESETS).map((preset) => ({
    id: preset.id,
    name: preset.name,
    description: preset.description,
  }));
}

/**
 * Create a custom workflow from a template
 */
export function createCustomWorkflow(
  id: string,
  name: string,
  options: {
    description?: string;
    steps?: WorkflowSpec["steps"];
    policy?: WorkflowSpec["policy"];
    synthesis?: WorkflowSpec["synthesis"];
  } = {}
): WorkflowSpec {
  return {
    id,
    name,
    description: options.description,
    steps: options.steps || [],
    policy: options.policy || { maxParallelism: 1, onStepFailure: "abort" },
    synthesis: options.synthesis || { strategy: "lead" },
  };
}

// Re-export types for convenience
export type { WorkflowSpec } from "./types";
