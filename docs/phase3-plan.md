# pi-conductor — Phase 3 Plan (English)

## Objective

Build the **workflow runtime layer** on top of Phase 2.

> Move from “resolving agents” → “executing multi-agent workflows with scheduling, isolation, and synthesis”.

## Current Status

- TypeScript build is passing via `npm run build`.
- Phase 3 runtime/status fixes have been merged into the implementation.
- Tests were intentionally removed from the repo, so test-related items below are informational until a replacement test strategy is added.

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

  status: "pending" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

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

---

# Implementation Checklist

## 1. Runner Contract

- [x] Define `SessionRunner` interface
- [x] Define `StepResultEnvelope` structure
- [x] Add runId / stepId / timestamps / status fields

Integrated fixes:
- Runner contract is aligned around `StepStatus` and optional `error`.
- A single `sessionId` is preserved across scheduler, runner, events, and final step results.

Files:
- `src/runtime/childSessionRunner.ts`
- `src/workflow/types.ts`

## 2. Local Process Runner

- [ ] Replace `DefaultSessionRunner` stub
- [x] Spawn child process
- [x] Capture stdout/stderr
- [x] Return structured result

Integrated fixes:
- `LocalProcessRunner` invokes the child process runtime, captures process output, and reads structured results from `result.json`.
- `DefaultSessionRunner` remains available as the non-process fallback.

Files:
- `src/runtime/childSessionRunner.ts`

## 3. Structured Output Channel

- [x] Write `result.json` per step
- [x] Separate logs vs structured output

Integrated fixes:
- Session context and structured outputs are written under `.pi/workflows/...`.
- Runtime falls back to stdout parsing when structured output is unavailable.

Files:
- `src/runtime/childSessionRunner.ts`
- `src/runtime/contextBuilder.ts`

## 4. Status Semantics

- [x] `pending / running / succeeded / failed / cancelled / timed_out`
- [x] Workflow-level status aggregation

Integrated fixes:
- Removed stale `completed` usage from the runtime and command layers.
- Progress events and workflow result formatting reflect the new status model.

Files:
- `src/runtime/orchestrator.ts`
- `src/runtime/scheduler.ts`
- `src/workflow/types.ts`

## 5. Failure Policy

- [x] abort behavior
- [x] continue-on-failure
- [x] skip dependents

Integrated fixes:
- Failure handling is aligned with dependency gating and workflow policy.
- Dependents remain blocked when required upstream steps fail.

Files:
- `src/runtime/scheduler.ts`

## 6. Timeout & Cancellation

- [x] Step timeout
- [x] Workflow cancel()
- [x] Kill child process

Integrated fixes:
- Step-level timeout and cancellation surface through step status.
- Workflow timeout/cancellation propagates into active running sessions.
- Scheduler calls `runner.cancelStep(sessionId)` for live sessions when the workflow is aborted.

Files:
- `src/runtime/orchestrator.ts`
- `src/runtime/scheduler.ts`
- `src/runtime/childSessionRunner.ts`

## 7. End-to-End Tests

- [ ] sequential workflow
- [ ] parallel workflow
- [ ] failure case
- [ ] timeout case
- [ ] cancellation case

Status note:
- Previous tests were removed from the repository. Reintroduce a replacement test strategy if end-to-end verification is needed again.

Files:
- `test/workflow.test.ts`

## 8. Command Alignment

- [x] Ensure `/team` and `/workflow` match the intended command surface

Integrated fixes:
- `/team` progress output matches the new workflow status model.
- `/workflow` command implementation has been added to inspect available workflows.

Files:
- `src/extension/commands/team.ts`
- `src/extension/commands/workflow.ts`

## 9. Observability Hooks

- [x] step started / completed / failed events
- [x] workflow lifecycle events

Integrated fixes:
- `step:pending`, `step:running`, `step:start`, and `step:complete` are wired.
- `workflow:timeout` and `workflow:cancelled` are connected to live scheduler control paths.

Files:
- `src/runtime/orchestrator.ts`
- `src/runtime/scheduler.ts`

## 10. Backend Abstraction

- [x] Extract `SessionRunner` interface
- [x] Ensure local runner works independently

Integrated fixes:
- Session execution remains abstracted behind `SessionRunner`.
- Local process execution and fallback execution are both available behind the same contract.

Files:
- `src/runtime/childSessionRunner.ts`

## Done When

- [x] Real child execution works
- [ ] All tests pass
- [x] Ready to add zellij backend

Open note:
- `All tests pass` remains unresolved because the tests were removed from the repository rather than repaired.

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
