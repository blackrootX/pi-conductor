# pi-conductor — Phase 3 Plan (English)

## Objective

Build the **workflow runtime layer** on top of Phase 2.

> Move from “resolving agents” → “executing multi-agent workflows with scheduling, isolation, and synthesis”.

---

# What Phase 3 Does

Phase 3 introduces a full **multi-agent orchestration runtime**:

- define workflows
- define steps and dependencies
- resolve steps to agents (via Phase 2)
- schedule execution (sequential + parallel)
- run isolated child agents
- collect structured results
- synthesize final output

---

# Core Responsibilities

## 1. Workflow Definition

Define a formal workflow model.

```ts
interface WorkflowSpec {
  id: string;
  name: string;
  description?: string;

  steps: WorkflowStep[];

  policy?: {
    maxParallelism?: number;
    onStepFailure?: "abort" | "continue";
  };

  synthesis?: {
    strategy?: "lead";
  };
}
```

---

## 2. Workflow Steps

```ts
type StepTarget =
  | { agentId: string }
  | { role: string }
  | { capability: string };

type WorkflowStep = {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
} & StepTarget;
```

Key rule:
> Steps declare intent. Registry resolves actual agents.

---

## 3. Workflow Presets

Provide built-in workflows:

### plan-implement-review
```
planner -> coder -> reviewer
```

### parallel-audit
```
backend audit
frontend audit
tests audit
docs audit
→ synthesis
```

### implement-and-review
```
coder -> reviewer
```

---

## 4. Workflow Resolution

Convert `WorkflowSpec` → resolved execution plan.

```ts
interface ResolvedWorkflowStep {
  id: string;
  title: string;
  prompt: string;
  dependsOn?: string[];
  agent: AgentSpec;
}
```

---

## 5. Scheduler (DAG-based)

Responsibilities:

- execute steps when dependencies are satisfied
- support:
  - sequential execution
  - parallel execution
- enforce `maxParallelism`
- respect failure policy

---

## 6. Child Session Runner

Each step runs in isolation.

Responsibilities:

- spawn child session
- inject:
  - agent system prompt
  - step prompt
  - dependency outputs
- execute
- collect result

Isolation rules:

- no shared context between siblings
- only dependency outputs flow forward

---

## 7. Context Builder

Construct input for each child run:

- agent prompt
- step prompt
- dependency summaries
- user task

---

## 8. Step Result Model

```ts
interface StepResultEnvelope {
  stepId: string;
  agentId: string;
  sessionId: string;

  status: "pending" | "running" | "completed" | "failed";

  summary: string;

  artifact: {
    type: "text" | "json";
    value: string | unknown;
  };

  startedAt: string;
  finishedAt?: string;
  error?: string;
}
```

---

## 9. Workflow Run Result

```ts
interface WorkflowRunResult {
  runId: string;
  workflowId: string;
  summary: string;
  finalText: string;
  stepResults: Record<string, StepResultEnvelope>;
}
```

---

## 10. Synthesis Layer

Responsibilities:

- collect all step results
- merge outputs
- produce final answer

Synthesis is NOT just another step — it is a final phase.

---

## 11. Command Surface

### /team

Run workflows:

```
/team "task"
/team <workflowId> "task"
```

### /workflow

Inspect workflows:

```
/workflow list
/workflow show <id>
```

---

## 12. Runtime Flow

```
User
 → /team "task"
 → select workflow
 → resolve steps → agents
 → scheduler executes
 → child sessions run
 → collect results
 → synthesis
 → final output
```

---

# Scope

## In scope

- workflow definition
- presets
- resolution
- scheduler
- child execution
- result models
- synthesis
- /team command

## Out of scope

- dynamic planner workflows
- retries/fallbacks
- UI streaming
- nested workflows

---

# Suggested Structure

```
src/
  workflow/
    types.ts
    presets.ts
    resolver.ts

  runtime/
    orchestrator.ts
    scheduler.ts
    childSessionRunner.ts
    contextBuilder.ts
    synthesizer.ts

  extension/
    commands/team.ts
```

---

# Deliverables

- workflow types
- presets
- resolver
- scheduler
- child runner
- synthesis
- /team execution

---

# Acceptance Criteria

- workflows execute end-to-end
- sequential + parallel both work
- agent resolution integrates with Phase 2
- outputs are structured
- final synthesis works
- /team runs successfully

---

# Milestones

1. Workflow types
2. Presets
3. Resolver
4. Scheduler
5. Child execution
6. Synthesis + /team

---

# Definition of Done

> System can take a task → run multi-agent workflow → return one final answer.

---

# Summary

- Phase 1: parse + normalize
- Phase 2: discover + resolve
- Phase 3: execute + orchestrate

> Phase 3 turns pi-conductor into a real multi-agent runtime.
