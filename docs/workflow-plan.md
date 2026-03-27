# Workflow Plan

## Summary

`pi-conductor` should keep a low-opinion workflow authoring model while upgrading the runtime into a small orchestrator.

The user-facing entrypoint remains `/workflow`. The internal orchestration layer is `conductor`, but users should not need to learn a new workflow DSL or rewrite their agents to adopt the current model.

The shipped baseline is still a sequential workflow system:

- built-in agents: `plan`, `build`
- built-in workflow: `plan-build`

The goal is still to let a user run:

```text
/workflow "implement auth"
```

or:

```text
/workflow plan-build "implement auth"
```

with a strong live UI in Pi and more reliable step handoff inside the runtime.

## Public UX

### Slash command

`/workflow` is a real extension slash command.

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

## Workflow File Format

`workflow.yaml` stays intentionally small.

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
- the current version still does not include per-step config in YAML
- if a referenced agent does not exist, validation fails before execution starts

## Agent Sources

Agents are loaded from normal Pi locations.

Agent lookup sources:

- project-local: `.pi/agents/`
- global: `~/.pi/agent/agents/`
- built-in agents shipped by the extension

Precedence:

1. project
2. global
3. built-in

Built-in agent names:

- `plan`
- `build`

User-defined or project-defined agents may override those names. They do not need extra workflow-specific frontmatter.

## Workflow Execution Semantics

The execution model is sequential. The workflow file still only describes order:

1. `plan` runs first
2. `build` runs second

Inside the runtime, the handoff is orchestrated:

1. the runtime builds a `WorkOrder` from `WorkflowState`
2. the step receives a runtime-injected structured response contract
3. the step returns a marker-block JSON result plus optional natural language
4. the runtime parses and validates the result
5. if parsing fails, the runtime does one repair retry
6. the parsed result is merged into shared workflow state
7. the next step receives a projection of that shared state

Failure behavior:

- validate the entire workflow before starting
- fail fast on the first missing, blocked, invalid, or failing step
- final tool result comes from aggregated workflow state, not just the last assistant message

## Built-in Agent Intent

### `plan`

Purpose:

- transform the user task into implementation-ready guidance for the workflow

Expected output style:

- concise
- code-oriented
- still flexible in prose
- compliant with the runtime-injected structured result contract

### `build`

Purpose:

- execute from the orchestrator-provided workflow context

Expected behavior:

- inspect the repository
- implement the change when implementation is actually requested
- report the outcome clearly
- return the structured result block required by the runtime

## UI and Rendering

The current subagent rendering is still the baseline for workflow UI.

Reuse heavily:

- chain-style streaming
- per-step tool calls
- per-step text updates
- final rendered markdown output
- usage summaries where helpful
- workflow-state summaries where helpful

- display the workflow UI directly in the current Pi session
- adapt the existing chain-style rendering to workflow terminology

## Notes

- `conductor` is an internal orchestration layer, not the user-facing command
- parallel steps, DAGs, resume, automatic agent selection, teams, team-workflow, and Zellij pane mirroring are out of scope here
- config, hooks, and skill/include loading are deferred to later versions
