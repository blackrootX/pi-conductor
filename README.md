# pi-conductor

Workflow-first Pi extension for running user-defined agents as lightweight sequential workflows.

## What It Does

`pi-conductor` adds a small orchestration layer on top of Pi agents:

- public command: `/workflow`
- internal tool/orchestrator: `conductor`
- built-in agents: `plan`, `build`
- built-in workflow: `plan-build`

The public authoring model stays intentionally simple:

- workflows stay as ordered `string[]` lists in YAML
- agents stay as normal Pi markdown agents
- the plugin injects a structured workflow contract at runtime
- step-to-step handoff goes through orchestrator state, not raw previous-step text
- if a step fails to produce structured output, the runtime does one repair retry

## Usage

Run the default workflow:

```text
/workflow "implement auth"
```

Run a named workflow:

```text
/workflow plan-build "implement auth"
```

Open the workflow picker:

```text
/workflow
```

## Workflow Definitions

Workflows are loaded from:

- project: `.pi/workflow.yaml`
- global: `~/.pi/agent/workflow.yaml`
- built-in defaults

Precedence:

1. project
2. global
3. built-in

Example `workflow.yaml`:

```yaml
plan-build:
  - plan
  - build

review-fix:
  - plan
  - build
  - review
```

Each workflow is still just a name mapped to an ordered list of agent names.

## Agent Definitions

Agents are loaded from:

- project: `.pi/agents/*.md`
- global: `~/.pi/agent/agents/*.md`
- built-in defaults

Built-in agents can be overridden by project or global agents with the same name.
User-defined agents do not need extra workflow-specific frontmatter.

## Execution Model

Workflow steps run sequentially, but the internal handoff is orchestrated.

For each step, `pi-conductor`:

1. builds a `WorkOrder` from the current shared workflow state
2. wraps the step with a structured response contract
3. parses the step output into a structured `AgentResult`
4. merges that result back into orchestrator-owned state
5. uses the updated state to prepare the next step

This keeps the public authoring model small while making the runtime handoff more reliable.

The structured contract is enforced by the runtime. Agents are asked to return a JSON block between:

```text
[WORKFLOW_RESULT_BEGIN]
{ ... }
[WORKFLOW_RESULT_END]
```

Free-form explanation outside the marker block is allowed. If parsing fails, the runtime attempts one repair retry before stopping the workflow.

## UI Behavior

Outside Zellij:

- the workflow runs in the current Pi session
- UI shows workflow state, step objectives, and per-step progress

Inside Zellij:

- `/workflow` opens a right-side pane automatically
- the left Pi session stays blocked until the workflow finishes
- the right pane shows one unified live workflow view for the workflow run
- when the workflow finishes, the right pane asks whether to close or stay open

Debug state is also persisted under `.pi/workflow-runs/<runId>/`.

## Current Scope

`v2` is still sequential only. It does not add:

- parallel steps
- DAG workflows
- resume
- automatic agent selection
- teams or team-workflow
- config, hooks, or skill/include loading

## Development

Install dependencies:

```bash
npm install
```

Typecheck:

```bash
npm run typecheck
```

## Install In Pi

Project-local install from this repo:

```bash
pi install -l .
```

Then reload or restart Pi in this repo and use:

```text
/workflow "implement auth"
```

If you want to remove the project-local install later:

```bash
pi remove -l .
```

If you already have another `pi-conductor` package installed globally and it also
registers `/workflow`, remove that older package first to avoid command conflicts:

```bash
pi remove https://github.com/blackrootX/pi-conductor
```

## Docs

- [Workflow plan](./docs/workflow-plan.md)
- [v2 plan](./docs/planv2.md)
- [v2 tasks](./docs/taskv2.md)
