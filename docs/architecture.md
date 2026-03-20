# pi-conductor — Complete Architecture Diagram

## 1. Full Module Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                         User / pi UI                         │
│                                                              │
│  /team "refactor auth system"                                │
│  /team workflow plan-implement-review "..."                  │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Extension Command Layer                   │
│                                                              │
│  commands/team.ts                                            │
│  tools/orchestrate.ts                                        │
│                                                              │
│  Responsibilities:                                           │
│  - parse user entry                                          │
│  - choose preset / workflow input                            │
│  - call orchestrator runtime                                 │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Orchestrator Runtime                      │
│                                                              │
│  orchestrator.ts                                             │
│                                                              │
│  Responsibilities:                                           │
│  - receive workflow request                                  │
│  - ask registry to resolve agents                            │
│  - construct execution plan                                  │
│  - call scheduler                                            │
│  - collect step results                                      │
│  - trigger synthesis                                         │
└───────────────┬───────────────────────────────┬──────────────┘
                │                               │
                │                               │
                ▼                               ▼
┌───────────────────────────────┐   ┌──────────────────────────┐
│         Agent Registry        │   │      Workflow Layer      │
│                               │   │                          │
│  discovery.ts                 │   │  workflow types          │
│  registry.ts                  │   │  workflow presets        │
│  parser.ts                    │   │  DAG / step definitions  │
│  normalizer.ts                │   │                          │
│                               │   │  Responsibilities:       │
│  Responsibilities:            │   │  - define steps          │
│  - load built-in agents       │   │  - define dependencies   │
│  - load user agents           │   │  - define synthesis rule │
│  - load project agents        │   │  - define policies       │
│  - precedence merge           │   └──────────────┬───────────┘
│  - resolveByRole              │                  │
│  - resolveByCapability        │                  │
└───────────────┬───────────────┘                  │
                │                                  │
                └──────────────┬───────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                          Scheduler                           │
│                                                              │
│  scheduler.ts                                                │
│                                                              │
│  Responsibilities:                                           │
│  - topological ordering                                      │
│  - sequential execution                                      │
│  - parallel execution                                        │
│  - maxParallelism                                            │
│  - failure policy                                            │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                    Child Session Runner                      │
│                                                              │
│  childSessionRunner.ts                                       │
│  contextBuilder.ts                                           │
│                                                              │
│  Responsibilities:                                           │
│  - spawn isolated child session                              │
│  - inject agent prompt + step prompt                         │
│  - pass dependency outputs                                   │
│  - run child agent                                           │
│  - collect normalized result                                 │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
         ┌─────────────────────────────────────────────┐
         │            Isolated Child Agents            │
         │                                             │
         │  planner agent                              │
         │  coder agent                                │
         │  reviewer agent                             │
         │  auditor agent                              │
         │  ... user/project custom agents             │
         └───────────────────┬─────────────────────────┘
                             │
                             ▼
┌──────────────────────────────────────────────────────────────┐
│                        Result Layer                          │
│                                                              │
│  StepResultEnvelope                                          │
│  WorkflowRunResult                                           │
│                                                              │
│  Responsibilities:                                           │
│  - normalize child outputs                                   │
│  - preserve step ordering                                    │
│  - store summaries / artifacts / status                      │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                       Synthesis Layer                        │
│                                                              │
│  synthesizer.ts                                              │
│                                                              │
│  Responsibilities:                                           │
│  - gather all step results                                   │
│  - build final answer                                        │
│  - return final text to lead session                         │
└──────────────────────────────┬───────────────────────────────┘
                               │
                               ▼
┌──────────────────────────────────────────────────────────────┐
│                         Final Output                         │
│                                                              │
│  User sees final merged result in pi                         │
└──────────────────────────────────────────────────────────────┘
```

---

## 2. Agent Source Structure

```text
                    ┌────────────────────┐
                    │   Built-in Agents  │
                    │  agents/*.md       │
                    └─────────┬──────────┘
                              │
                              │
                    ┌─────────▼──────────┐
                    │  User Agents       │
                    │ ~/.pi/agent/agents │
                    └─────────┬──────────┘
                              │
                              │
                    ┌─────────▼──────────┐
                    │ Project Agents     │
                    │ .pi/agents         │
                    └─────────┬──────────┘
                              │
                              ▼
                   ┌──────────────────────┐
                   │  parser + normalizer │
                   └─────────┬────────────┘
                             ▼
                   ┌──────────────────────┐
                   │      AgentSpec       │
                   │ normalized agents    │
                   └─────────┬────────────┘
                             ▼
                   ┌──────────────────────┐
                   │    AgentRegistry     │
                   │ precedence + resolve │
                   └─────────┬────────────┘
                             ▼
                   ┌──────────────────────┐
                   │ resolved agent       │
                   │ for workflow step    │
                   └──────────────────────┘
```

Precedence:

```text
project > user > built-in
```

---

## 3. Runtime Data Flow

```text
User
 │
 │  /team "refactor auth system"
 ▼
Command Layer
 │
 │ parse input
 │ choose preset / workflow template
 ▼
Workflow Builder
 │
 │ build WorkflowSpec
 │   - steps
 │   - dependencies
 │   - policies
 ▼
AgentRegistry
 │
 │ for each step:
 │   resolveByRole / resolveByCapability
 ▼
Resolved Execution Plan
 │
 │ step1 -> planner agent
 │ step2 -> coder agent
 │ step3 -> reviewer agent
 ▼
Scheduler
 │
 ├── sequential path
 │     step1 -> step2 -> step3
 │
 └── parallel path
       stepA + stepB + stepC together
 ▼
Child Session Runner
 │
 │ for each step:
 │  - create isolated child session
 │  - build context
 │  - inject dependency outputs
 │  - run child
 ▼
StepResultEnvelope[]
 │
 │ normalize outputs
 ▼
Synthesizer
 │
 │ merge summaries / artifacts / findings
 ▼
Final Answer
 │
 ▼
User
```

---

## 4. Module Responsibility Breakdown

```text
src/
├── index.ts
│   └── public exports only
│
├── parser.ts
│   └── parse markdown + YAML frontmatter
│
├── normalizer.ts
│   └── normalize raw agent data -> AgentSpec
│
├── errors.ts
│   └── parse / normalize / resolve error types
│
├── discovery.ts
│   └── discover built-in, user, project agent files
│
├── registry.ts
│   └── AgentRegistry
│       - loadAll
│       - listAgents
│       - listErrors
│       - listDiagnostics
│       - findById
│       - resolveByRole
│       - resolveByCapability
│
├── workflow/
│   ├── types.ts
│   ├── presets.ts
│   └── builder.ts
│
├── runtime/
│   ├── orchestrator.ts
│   ├── scheduler.ts
│   ├── childSessionRunner.ts
│   ├── contextBuilder.ts
│   └── synthesizer.ts
│
└── extension/
    ├── commands/team.ts
    └── tools/orchestrate.ts
```

---

## 5. Phase Mapping

```text
Phase 1
-------
agent markdown
   -> parser
   -> normalizer
   -> AgentSpec

Phase 2
-------
AgentSpec
   -> discovery
   -> precedence merge
   -> AgentRegistry
   -> resolveByRole / resolveByCapability

Phase 3
-------
AgentRegistry + WorkflowSpec
   -> scheduler
   -> child session runner
   -> step results
   -> synthesis
   -> final output
```

---

## 6. Final Mental Model

```text
                 pi-conductor
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
   Agent Layer    Registry Layer   Workflow Layer
   (who exists)   (who is chosen)  (how work is split)
                                           │
                                           ▼
                                   Execution Layer
                                   (who runs when)
                                           │
                                           ▼
                                   Synthesis Layer
                                   (how results merge)
```

Short version:

- **Phase 1**: what agents exist
- **Phase 2**: which agent gets selected
- **Phase 3**: how agents collaborate to complete work
