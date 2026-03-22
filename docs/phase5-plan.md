# Phase 5 Plan: Workflow Productization

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the current workflow runner into a coherent end-user product with strong Pi-native UX, reusable workflow configuration, visible execution, and clearer long-lived workflow state.

**Architecture:** Build on the existing orchestrator, scheduler, runner, and extension command structure instead of redesigning execution. Keep Pi as the control plane, keep Zellij as an optional execution surface, and add higher-level workflow concepts such as templates, skills, and approval gates at the workflow-definition and extension-UI layers.

**Tech Stack:** TypeScript, Pi extension API, Pi workflow runtime, Zellij, JSON settings, markdown agent definitions

---

## Current Baseline

This plan assumes the following is already true in the current repo:

- `/workflow` interactive mode is Pi-native in [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- `/workflow run`, `/workflow list`, `/workflow add`, and `/workflow remove` work through [src/extension/commands/workflow.ts](/Users/tree/Code/Github/pi-conductor/src/extension/commands/workflow.ts)
- workflow progress is sent back to the main Pi session via status, widget, and custom workflow messages
- `LocalProcessRunner` is the default execution backend
- `ZellijRunner` exists and can run workflow steps in visible sessions
- workflow sessions are cleaned after runs and run history is pruned automatically
- `.pi/workflows/sessions/` and `.pi/workflows/runs/` are ignored by git

This plan is therefore about the next layer of product quality, not “make workflows run at all”.

---

## Lessons To Adopt From `pi-teams`

The strongest lessons from `pi-teams` are:

- execution needs a clear user mental model, not just a runner
- the multiplexer is a view/backend, not the source of truth
- durable workflow state matters more than pane mechanics
- approval and coordination are first-class workflow concerns
- templates and reusable definitions matter
- skill composition is a better scaling tool than creating endless bespoke agents
- cleanup should exist both automatically and through a user-facing command
- environment-specific behavior must be documented explicitly

These should shape the remaining Phase 5 work.

---

## Scope

In scope:

- formalize the workflow state model as product concepts
- add user-defined workflow templates
- add workflow skill integration
- add optional approval gates for selected workflow steps
- add user-facing cleanup controls
- improve Zellij visibility semantics and documentation
- improve Pi-native workflow UX around history and inspection

Out of scope:

- rewriting the orchestrator/scheduler core
- replacing built-in workflow presets
- adding a full team/task-board system like `pi-teams`
- reintroducing a large automated test suite in this phase

---

## File Map

Likely files to touch:

- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [src/extension/commands/workflow.ts](/Users/tree/Code/Github/pi-conductor/src/extension/commands/workflow.ts)
- Modify: [src/workflow/types.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/types.ts)
- Modify: [src/workflow/presets.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/presets.ts)
- Modify: [src/workflow/resolver.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/resolver.ts)
- Modify: [src/runtime/childSessionRunner.ts](/Users/tree/Code/Github/pi-conductor/src/runtime/childSessionRunner.ts)
- Modify: [src/runtime/zellijRunner.ts](/Users/tree/Code/Github/pi-conductor/src/runtime/zellijRunner.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)
- Create: [src/workflow/templates.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/templates.ts)
- Create: [src/workflow/skills.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/skills.ts)
- Create: [src/workflow/approval.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/approval.ts)

Potential user-data files to support:

- `.pi/workflows.json`
- `.pi/workflows.yaml`
- `~/.pi/workflows.json`
- `~/.pi/workflows.yaml`

Prefer one format only for v1. JSON is the simpler first step unless you explicitly want YAML.

---

## Chunk 1: Stabilize The Product Model

### Task 1: Define the workflow product concepts

**Files:**

- Modify: [docs/phase5-plan.md](/Users/tree/Code/Github/pi-conductor/docs/phase5-plan.md)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)
- Modify: [src/workflow/types.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/types.ts)

- [ ] Add explicit terminology to docs and types:
  - workflow definition
  - workflow run
  - workflow session scratch data
  - workflow run artifacts
  - execution backend
  - visibility mode
  - approval-gated step
  - skill-enhanced step

- [ ] Extend workflow types to support future fields without changing existing preset behavior:
  - `skills?: string[]`
  - `requiresApproval?: boolean`
  - `templateSource?: "built-in" | "project" | "user"`

- [ ] Keep all new fields optional so current presets still resolve unchanged.

- [ ] Update README language so it describes:
  - Pi main session as the control plane
  - Zellij as the optional execution plane
  - `sessions/` as scratch state
  - `runs/` as retained history

- [ ] Commit.

### Task 2: Add user-facing cleanup command

**Files:**

- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [src/extension/commands/workflow.ts](/Users/tree/Code/Github/pi-conductor/src/extension/commands/workflow.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)

- [ ] Add a Pi-native `/workflow` menu action for cleanup.

- [ ] Add a direct subcommand shape:
  - `/workflow cleanup`

- [ ] Support cleaning:
  - session scratch dirs only
  - old run artifacts only
  - both

- [ ] Document default retention:
  - session dirs are removed after workflow completion
  - only the latest 20 runs are kept automatically

- [ ] Commit.

---

## Chunk 2: User-Defined Workflow Templates

### Task 3: Add project and user workflow template loading

**Files:**

- Create: [src/workflow/templates.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/templates.ts)
- Modify: [src/workflow/presets.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/presets.ts)
- Modify: [src/extension/commands/workflow.ts](/Users/tree/Code/Github/pi-conductor/src/extension/commands/workflow.ts)
- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)

- [ ] Choose one file format for v1:
  - prefer JSON for simplicity

- [ ] Load user workflow templates from:
  - `~/.pi/workflows.json`

- [ ] Load project workflow templates from:
  - `.pi/workflows.json`

- [ ] Merge precedence:
  1. project templates
  2. user templates
  3. built-in presets

- [ ] Expose user-defined workflows through the same listing and selection path as built-ins.

- [ ] Mark template source in workflow display so users can tell whether a workflow is built-in, project, or user.

- [ ] Commit.

### Task 4: Add saveable workflow templates

**Files:**

- Create: [src/workflow/templates.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/templates.ts)
- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [src/extension/commands/workflow.ts](/Users/tree/Code/Github/pi-conductor/src/extension/commands/workflow.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)

- [ ] Add a Pi-native save flow for current built-in or project workflows:
  - choose source workflow
  - choose target scope
  - choose new template id

- [ ] Write the saved workflow into project or user workflow storage.

- [ ] Reject duplicate ids unless the user explicitly confirms overwrite.

- [ ] Keep saved templates structurally compatible with existing workflow resolution.

- [ ] Commit.

---

## Chunk 3: Skill Integration

### Task 5: Add skill support to workflow steps

**Files:**

- Create: [src/workflow/skills.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/skills.ts)
- Modify: [src/workflow/types.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/types.ts)
- Modify: [src/runtime/childSessionRunner.ts](/Users/tree/Code/Github/pi-conductor/src/runtime/childSessionRunner.ts)
- Modify: [src/runtime/zellijRunner.ts](/Users/tree/Code/Github/pi-conductor/src/runtime/zellijRunner.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)

- [ ] Add `skills?: string[]` to workflow steps.

- [ ] Add a small “effective skill list” helper that computes:
  - workflow shared skills, if supported later
  - step-level skills, for v1

- [ ] Pass skills into child execution in one consistent way.

- [ ] Prefer explicit invocation if Pi supports it cleanly; otherwise inject skill references into the generated step context.

- [ ] Document how skills are meant to be used:
  - agents define broad role/identity
  - skills define reusable playbooks/specialization

- [ ] Commit.

### Task 6: Add Pi-native workflow inspection for skills

**Files:**

- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [src/extension/commands/workflow.ts](/Users/tree/Code/Github/pi-conductor/src/extension/commands/workflow.ts)

- [ ] Make workflow inspection show:
  - step agent target
  - step dependencies
  - step skills, if any
  - whether a step requires approval

- [ ] Keep inspection available both from direct subcommands and Pi-native selection UI.

- [ ] Commit.

---

## Chunk 4: Approval Gates

### Task 7: Add optional per-step approval gates

**Files:**

- Create: [src/workflow/approval.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/approval.ts)
- Modify: [src/workflow/types.ts](/Users/tree/Code/Github/pi-conductor/src/workflow/types.ts)
- Modify: [src/runtime/orchestrator.ts](/Users/tree/Code/Github/pi-conductor/src/runtime/orchestrator.ts)
- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)

- [ ] Add `requiresApproval?: boolean` to steps.

- [ ] Define the minimum approval behavior:
  - step completes and reports its proposed result
  - workflow pauses before continuing
  - user can approve or reject through Pi UI

- [ ] Keep v1 narrow:
  - approval gates only block the transition to downstream steps
  - rejected steps fail or cancel the workflow cleanly

- [ ] Surface approval state in:
  - main Pi status/widget
  - custom workflow message

- [ ] Commit.

---

## Chunk 5: Better Visibility Semantics

### Task 8: Make Zellij visibility more explicit

**Files:**

- Modify: [src/runtime/zellijRunner.ts](/Users/tree/Code/Github/pi-conductor/src/runtime/zellijRunner.ts)
- Modify: [extensions/workflow.ts](/Users/tree/Code/Github/pi-conductor/extensions/workflow.ts)
- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)

- [ ] Give workflow Zellij sessions and panes clearer names:
  - workflow id
  - run id
  - step title or agent name

- [ ] Record enough metadata to correlate:
  - main Pi workflow run
  - Zellij session
  - step session id

- [ ] Improve user-facing copy for visible mode:
  - inside Zellij
  - outside Zellij
  - detached fallback

- [ ] Keep the key invariant:
  - Pi main session is where structured summaries live
  - Zellij is where live step execution is visible

- [ ] Commit.

---

## Chunk 6: Final Documentation Pass

### Task 9: Rewrite docs around the product model

**Files:**

- Modify: [README.md](/Users/tree/Code/Github/pi-conductor/README.md)
- Modify: [docs/phase5-plan.md](/Users/tree/Code/Github/pi-conductor/docs/phase5-plan.md)

- [ ] Document:
  - workflow templates
  - project vs user workflow sources
  - skills in workflow steps
  - approval gates
  - cleanup behavior
  - Zellij environment behavior

- [ ] Add realistic examples using:
  - built-in workflow
  - custom workflow template
  - skill-enhanced review workflow
  - approval-gated implement workflow

- [ ] Commit.

---

## Acceptance Criteria

Phase 5 is complete when:

- `/workflow` feels Pi-native and is the primary user control surface
- user-defined workflows can be loaded from project and user scope
- workflows can be saved as reusable templates
- workflow steps can use skills
- selected workflow steps can require approval
- Zellij remains an optional visible execution surface with well-documented fallback behavior
- run/session cleanup is both automatic and user-invokable
- README explains the real execution model clearly

---

## Suggested Commit Sequence

1. `docs: define phase 5 product model`
2. `feat: add workflow cleanup command`
3. `feat: load workflow templates from project and user scope`
4. `feat: save workflow templates`
5. `feat: add workflow step skills`
6. `feat: add approval-gated workflow steps`
7. `feat: improve zellij workflow metadata and naming`
8. `docs: document workflow templates skills and approvals`

---

Plan complete and saved to [docs/phase5-plan.md](/Users/tree/Code/Github/pi-conductor/docs/phase5-plan.md). Ready to execute?
