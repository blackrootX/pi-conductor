# Phase 5 Plan: Workflow Settings UX + Multiplexer Visibility

## Goal

Make `/workflow` the user-facing control surface for:

- selecting configured workflows
- managing lightweight workflow settings
- choosing how visible workflow execution should be
- optionally running workflows inside a multiplexer such as Zellij

Phase 5 should build on the existing Phase 4 runtime rather than replacing it.

---

## Current Code Review

This plan is designed against the current implementation, not a greenfield rewrite.

What already exists:
- `/workflow add <id>` persists configured workflows
- `/workflow list` reads configured workflows
- plain `/workflow` prompts for a workflow and then a task
- `/workflow run <id> --task "..."` executes directly
- project settings override user settings for `conductorWorkflow`
- `LocalProcessRunner` is the real execution backend
- sequential execution is the default for `/workflow run`
- artifact persistence already exists for results and logs
- per-agent model is passed to `pi run` when defined

Relevant implementation points:
- workflow command: `src/extension/commands/workflow.ts`
- team command: `src/extension/commands/team.ts`
- runner abstraction: `src/runtime/childSessionRunner.ts`
- orchestrator/scheduler: `src/runtime/orchestrator.ts`, `src/runtime/scheduler.ts`

Implication:
- Phase 5 should not redesign scheduling, synthesis, or runner contracts
- Phase 5 should focus on UX, settings, backend selection, and visible execution mode

---

## Scope

In scope:
- extend settings to include workflow multiplexer/display preferences
- add `/workflow settings` UX
- add a visible execution mode using a multiplexer backend
- define inside-Zellij vs outside-Zellij behavior
- keep `/team` as a higher-level abstraction

Out of scope:
- rewriting workflow definitions
- changing workflow preset semantics
- parallel UX redesign
- replacing `LocalProcessRunner` as the default non-multiplexer backend
- reintroducing the test suite in this phase

---

## Settings Model

Phase 5 keeps the config intentionally small.

### User settings file

```text
~/.pi/agent/settings.json
```

### Project settings file

```text
<project>/.pi/agent/settings.json
```

### Precedence

1. project settings
2. user settings

Project settings should override user settings when a key is present.

### Proposed keys

```json
{
  "conductorWorkflow": [
    "plan-implement-review",
    "quick-review"
  ],
  "conductorWorkflowMultiplexer": "none",
  "conductorWorkflowDisplay": "main-window"
}
```

### Key semantics

- `conductorWorkflow`
  - ordered array of configured workflow IDs
  - first item is the default/recommended workflow

- `conductorWorkflowMultiplexer`
  - allowed values:
    - `"none"`
    - `"zellij"`

- `conductorWorkflowDisplay`
  - allowed values:
    - `"main-window"`
    - `"split-pane"`

Rule:
- `conductorWorkflowDisplay` only matters when `conductorWorkflowMultiplexer = "zellij"`

---

## Command UX

Phase 5 should turn `/workflow` into a small interactive menu.

### Top-level menu

```text
/workflow
1. Run workflow
2. List workflows
3. Add workflow
4. Settings
```

### Settings menu

```text
Workflow Settings
1. Multiplexer
2. Display strategy
3. Save scope
4. Configured workflows
```

### Multiplexer choices

```text
1. none
2. zellij
```

### Display strategy choices

```text
1. main-window
2. split-pane
```

### Behavioral expectations

- `/workflow`
  - opens top-level menu
- `Run workflow`
  - shows configured workflows
  - user selects workflow
  - user enters task
  - workflow executes
- `List workflows`
  - shows configured workflows from settings
- `Add workflow`
  - prompts for workflow ID
  - validates and writes to settings
- `Settings`
  - allows updating multiplexer, display strategy, and save scope

CLI compatibility should remain:

```bash
/workflow add <id>
/workflow list
/workflow run <id> --task "..."
/workflow --show <id>
```

Interactive menu and direct subcommands should coexist.

---

## Execution Modes

Phase 5 introduces two visibility strategies when multiplexer support is enabled.

### 1. `none`

Current behavior:
- use normal command flow
- run with `LocalProcessRunner`
- persist artifacts to disk
- print progress in the main terminal

### 2. `zellij`

Visible execution mode:
- workflow steps execute in Zellij-backed sessions/panes
- command still returns structured workflow results
- session/pane visibility depends on `conductorWorkflowDisplay`

---

## Zellij Display Strategies

### `main-window`

Meaning:
- workflow becomes the primary visible UI

If already inside Zellij:
- create or switch to a dedicated workflow tab
- workflow becomes the main active view

If outside Zellij:
- fall back to a detached Zellij session
- print attach instructions
- do not try to replace the current non-Zellij terminal UI automatically

### `split-pane`

Meaning:
- user keeps current context while workflow appears alongside it

If already inside Zellij:
- create panes in the current session/tab

If outside Zellij:
- cannot literally split the current non-Zellij terminal
- fallback behavior:
  - start detached Zellij session
  - print attach instructions

Key rule:
- `conductorWorkflowDisplay` only changes live layout when already inside Zellij
- outside Zellij, both strategies fall back to a detached session with attach instructions

---

## Detection Logic

Phase 5 should explicitly detect whether workflow execution is already inside Zellij.

### Detect active Zellij context

Recommended signal:

```ts
const inZellij = Boolean(process.env.ZELLIJ);
```

### Detect Zellij availability

Recommended check:

```bash
command -v zellij
```

### Decision table

If `multiplexer = none`:
- use `LocalProcessRunner`

If `multiplexer = zellij` and inside Zellij:
- use current session
- apply configured display strategy

If `multiplexer = zellij` and outside Zellij:
- create detached Zellij session
- start workflow there
- print:

```text
Started workflow in Zellij session:
<session-name>

Attach with:
zellij attach <session-name>
```

If `zellij` is not installed:
- fail clearly
- suggest falling back to `none`

---

## Backend Design

Phase 5 should preserve the existing runner boundary.

### Existing runner boundary

- `SessionRunner` remains the abstraction
- `LocalProcessRunner` remains the default non-multiplexer runtime
- `DefaultSessionRunner` remains fallback/dev-only behavior

### New runner

Add:

```ts
class ZellijRunner implements SessionRunner
```

Responsibilities:
- create or reuse Zellij session
- create workflow panes/tabs
- launch `pi run --agent <id> --model <model>` in pane context
- wait for `result.json`
- persist/copy logs
- return `StepResultEnvelope`

Important design rule:
- Zellij-specific behavior belongs in `ZellijRunner`
- do not move Zellij orchestration into scheduler/orchestrator

---

## Suggested Zellij Session Layout

Reuse the current artifact/session structure as much as possible.

### Filesystem

```text
.pi/workflows/sessions/{sessionId}/
  system.md
  task.md
  result.json
  stdout.log
  stderr.log
  zellij.json
```

### `zellij.json`

```json
{
  "sessionId": "session-123",
  "workflowId": "plan-implement-review",
  "runId": "run-123",
  "zellijSession": "pi-plan-implement-review-run-123",
  "paneId": "7",
  "stepId": "implement"
}
```

This should be metadata only, not the source of truth for step results.

---

## `/workflow settings` Deliverables

### Step 1

Extend settings read/write helpers to support:
- `conductorWorkflowMultiplexer`
- `conductorWorkflowDisplay`

### Step 2

Add interactive settings menu to `/workflow`

### Step 3

Allow choosing:
- `none` vs `zellij`
- `main-window` vs `split-pane`

### Step 4

Persist changes back to:
- project settings by default
- user settings only if explicitly chosen later

Recommended Phase 5 default:
- write settings to project scope when run inside a project

---

## `/workflow` Behavior After Phase 5

### Plain `/workflow`

Should open menu:
- Run workflow
- List workflows
- Add workflow
- Settings

### `/workflow run <id> --task "..."`

Should:
- resolve effective settings
- choose backend:
  - `LocalProcessRunner` when multiplexer is `none`
  - `ZellijRunner` when multiplexer is `zellij`
- execute workflow using existing orchestrator path

### `/workflow list`

Should list configured workflows from effective settings.

### `/workflow add <id>`

Should validate workflow ID and append to `conductorWorkflow`.

### `/workflow settings`

Should provide an explicit shortcut into the settings menu.

---

## Review Notes Against Current Code

This plan is valid against the current implementation because:

- current `/workflow` already has settings-backed configured workflows
- current `/workflow` already has an interactive prompt path
- current `LocalProcessRunner` already persists session files and logs
- current runner boundary is strong enough to add a `ZellijRunner`
- current command behavior does not need to change fundamentally

This plan deliberately avoids proposing changes that would conflict with current code:

- no replacement of `LocalProcessRunner`
- no changes to workflow schema
- no requirement that declaration order define execution order
- no forcing users to start inside Zellij first

Open caveats:
- interactive command prompts currently rely on readline-based terminal IO
- exact host integration for slash-command menus may need adaptation depending on Pi’s command host
- no automated test suite is currently present

---

## Acceptance Criteria

Phase 5 is done when:

- `/workflow` exposes a settings path
- settings support multiplexer + display strategy
- project and user settings both work with project override
- `LocalProcessRunner` remains default for non-multiplexer execution
- `ZellijRunner` can be selected through settings
- outside-Zellij behavior is explicit and safe
- inside-Zellij behavior is visible and predictable
- docs explain `none`, `zellij`, `main-window`, and `split-pane`

---

## Not In Phase 5

- reintroducing full automated tests
- parallel pane UX redesign
- nested workflows
- resume/debug UI
- non-Zellij multiplexer support

---

## Recommended Implementation Order

1. Extend settings model for multiplexer/display strategy
2. Add `/workflow settings` interactive flow
3. Add runner selection based on effective settings
4. Implement `ZellijRunner`
5. Implement inside-Zellij vs outside-Zellij behavior
6. Update README and docs
