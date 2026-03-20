# pi-conductor — v1 Architecture Spec

## 1. Design Goals

- Provide **multi-agent orchestration** (sequential + parallel)
- Stay **minimally opinionated**
- Keep **pi as the execution substrate**, not replace it
- Support:
  - isolated child sessions
  - DAG-based workflows
  - lead-agent synthesis

- Avoid:
  - hardcoded roles
  - fixed workflows
  - autonomous loops

---

## 2. Core Model

### Mental Model

```
User → Lead Session → Orchestrator → Child Sessions → Results → Lead Synthesis
```

- **Lead session**: user-facing, controls orchestration
- **Child sessions**: isolated workers
- **Orchestrator**: scheduler + runtime
- **Workflow**: DAG of tasks

---

## 3. Core Concepts

### AgentSpec

```ts
type AgentRole = string;

interface AgentSpec {
  id: string;
  role: AgentRole;
  systemPrompt?: string;
  model?: string;
  readOnly?: boolean;
}
```

---

### WorkflowStep (no mode)

```ts
interface WorkflowStep {
  id: string;
  title: string;
  agentId: string;
  prompt: string;
  dependsOn?: string[];
  scope?: {
    files?: string[];
    description?: string;
  };
  required?: boolean; // default true
  timeoutMs?: number;
}
```

👉 Execution type (parallel/sequential) is derived from `dependsOn`, NOT a `mode` field.

---

### WorkflowSpec

```ts
interface WorkflowSpec {
  id: string;
  name: string;
  agents: AgentSpec[];
  steps: WorkflowStep[];

  synthesis?: {
    strategy?: "lead"; // future: "child-agent"
  };

  policy?: {
    maxParallelism?: number; // default 3
    onStepFailure?: "abort" | "continue"; // default abort
  };
}
```

---

## 4. Result Contract (fixed)

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

👉 Single artifact field — no split between `outputText` / `outputJson`.

---

## 5. Execution Model

### DAG-based scheduling

- Steps run when all dependencies are completed
- Parallelism emerges naturally
- No explicit `mode` needed

---

### Sequential example

```
A → B → C
```

---

### Parallel example

```
A
B
C
→ synthesis
```

---

### Mixed DAG

```
A → B
A → C
B + C → D
```

---

## 6. Runtime Architecture

```
extension/
  orchestrate tool
  /team command

runtime/
  orchestrator
  scheduler
  childSessionRunner
  synthesizer
  stateStore
```

---

## 7. Orchestrator Responsibilities

- initialize run state
- resolve workflow
- execute scheduler
- collect results
- perform synthesis
- return final output

---

## 8. Scheduler

### Behavior

- Find runnable steps (dependencies satisfied)
- Execute up to `maxParallelism`
- Wait for completion
- Repeat until done

### Failure handling

- default: abort entire run
- optional: continue (future)

---

## 9. Child Session Execution

Each step:

1. Create isolated session
2. Build prompt:
   - role instructions
   - task prompt
   - dependency outputs (summarized)

3. Execute
4. Parse into `StepResultEnvelope`

---

### Isolation rules

- No shared transcript between children
- Only dependency outputs are passed forward
- Children are read-only by default

---

## 10. Synthesis (separate phase)

Synthesis is NOT a workflow step.

### Process

1. Collect all step results
2. Order by workflow definition (not completion time)
3. Lead agent produces final output

---

### Output

```ts
interface WorkflowRunResult {
  runId: string;
  summary: string;
  finalText: string;
  stepResults: Record<string, StepResultEnvelope>;
}
```

---

## 11. Policies (v1 defaults)

```ts
{
  maxParallelism: 3,
  onStepFailure: "abort",
  childWritePolicy: "none"
}
```

---

## 12. Workflow Presets (optional)

Examples:

### plan-implement-review

```
planner → coder → reviewer
```

### parallel-audit

```
backend
frontend
tests
docs
→ synthesis
```

---

## 13. What is intentionally NOT included (v1)

- nested workflows
- autonomous loops
- dynamic replanning
- file ownership system
- multi-writer concurrency
- cost optimization
- inter-agent messaging

---

## 14. Key Principles

### 1. Orchestration, not framework

- no hardcoded roles
- no fixed system behavior

### 2. Isolation first

- separate sessions
- minimal context sharing

### 3. DAG > modes

- dependencies define execution
- parallelism is emergent

### 4. Lead controls output

- children propose
- lead decides

---

## 15. Future Extensions (v2+)

- DAG visualization
- child agent synthesis
- retry / fallback strategies
- file ownership / worktrees
- streaming partial results
- nested workflows

---

## 16. Summary

This system is:

- **not a team product**
- **not an autonomous agent system**
- **not a framework**

It is:

> a minimal orchestration runtime that enables team-like behavior on top of pi

---
