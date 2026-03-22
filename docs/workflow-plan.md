# Workflow Plan

## Summary

`pi-conductor` should focus first on a workflow-first experience built on top of the imported `subagent` execution and rendering ideas.

The user-facing entrypoint is `/workflow`. The internal orchestration layer can still reuse and refactor the current `subagent` code, but `subagent` is not part of the public product surface.

The first shipped experience is a built-in sequential workflow:

- built-in agents: `plan`, `build`
- built-in workflow: `plan-build`

The goal is to let a user run:

```text
/workflow "implement auth"
```

or:

```text
/workflow plan-build "implement auth"
```

with a strong live UI in Pi, and with optional automatic Zellij mirroring when Pi is already running inside Zellij.

## Public UX

### Slash command

`/workflow` should be implemented as a real extension slash command, not just a prompt alias.

Supported behavior:

- `/workflow`
  - opens a Pi picker listing available workflows
  - each option shows workflow name plus source
  - after selection, Pi asks for one free-text runtime task
- `/workflow "task"`
  - runs the default workflow `plan-build`
- `/workflow <workflow-name> "task"`
  - runs the named workflow directly without extra confirmation

### Workflow sources

Workflows are loaded from:

- project-local: `.pi/workflow.yaml`
- global: `~/.pi/agent/workflow.yaml`
- built-in defaults provided by the extension

Precedence:

1. project
2. global
3. built-in

If the same workflow name exists in multiple places, the higher-precedence source wins.

Built-in workflows should still appear in the picker and be labeled with source `built-in`.

## Workflow File Format

`workflow.yaml` should stay intentionally small.

Example:

```yaml
plan-build:
  - plan
  - build

review-fix:
  - plan
  - build
  - review
```

Rules:

- one file can define multiple named workflows
- each workflow is a mapping from workflow name to ordered agent names
- v1 does not include per-step config in YAML
- if a referenced agent does not exist, validation fails before execution starts

## Agent Sources

Agents are loaded from normal Pi locations and should not use the old symlink installation pattern from the upstream example.

Agent lookup sources:

- project-local: `.pi/agents/`
- global: `~/.pi/agent/agents/`
- built-in agents shipped by the extension

Precedence:

1. project
2. global
3. built-in

Built-in agent names for v1:

- `plan`
- `build`

User-defined or project-defined agents may override those names.

## Workflow Execution Semantics

The execution model is sequential.

The workflow definition:

```yaml
plan-build:
  - plan
  - build
```

means:

1. `plan` runs first
2. `build` runs second

Step input rules:

- first step receives the user task
- each later step receives only the previous step's output

So for:

```text
/workflow "implement auth"
```

the handoff is:

1. `plan` receives `implement auth`
2. `build` receives only the text output from `plan`

Failure behavior:

- validate the entire workflow before starting
- fail fast on the first missing or failing step
- final tool result should emphasize the final step output plus a workflow step summary

## Built-in Agent Intent

### `plan`

Purpose:

- transform the user task into implementation-ready instructions for the next step

Expected output style:

- concise
- code-oriented
- directly usable by `build`
- free-form text, not a rigid schema

### `build`

Purpose:

- execute from the previous step's output

Expected behavior:

- inspect the repository
- implement the change
- report the outcome clearly

`build` should assume planner output is normal free-form text.

## UI and Rendering

The current upstream `subagent` rendering is the baseline for workflow UI.

Reuse heavily:

- chain-style streaming
- per-step tool calls
- per-step text updates
- final rendered markdown output
- usage summaries where helpful

Outside Zellij:

- display the workflow UI directly in the current Pi session
- adapt the existing chain-style rendering to workflow terminology

Inside Zellij:

- automatically open a right-side split pane
- show one unified live workflow view for the whole run
- do not create one pane per step
- keep the pane open after completion with final status visible

The side pane should display a real live Pi/subagent-style workflow view, not a simplified text mirror.

## Zellij Behavior

Zellij support is visualization only in v1.

The workflow still runs as one orchestrated extension execution.

Rules:

- if Pi is already running inside Zellij, auto-open the workflow pane
- if Pi is not running inside Zellij, do not try to launch external Zellij UI
- show a lightweight completion notification
- support clean abort behavior
- pause, resume, and step retry are out of scope for v1

## Notes

- `conductor` is an internal orchestration layer, not the user-facing command
- `/team` is deferred and should not drive the first implementation
- the first milestone should prioritize a strong `/workflow` experience over broader multi-agent features
