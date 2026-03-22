# pi-conductor

Workflow-first Pi extension built on top of the upstream subagent execution model.

## What It Does

`pi-conductor` turns the imported subagent chain execution into a workflow product:

- public command: `/workflow`
- internal tool/orchestrator: `conductor`
- built-in agents: `plan`, `build`
- built-in workflow: `plan-build`

The first version focuses on sequential workflows.

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

Each workflow is just a name mapped to an ordered list of agent names.

## Agent Definitions

Agents are loaded from:

- project: `.pi/agents/*.md`
- global: `~/.pi/agent/agents/*.md`
- built-in defaults

Built-in agents can be overridden by project or global agents with the same name.

## Execution Model

Workflow steps run sequentially.

Input handoff is intentionally simple:

- step 1 receives the user task
- each later step receives only the previous step's output

That means the built-in `plan-build` flow behaves like this:

1. `plan` receives the user task
2. `build` receives the planner output

## UI Behavior

Outside Zellij:

- the workflow runs in the current Pi session
- UI reuses the upstream subagent-style streaming workflow display

Inside Zellij:

- `/workflow` opens a right-side pane automatically
- that pane runs a dedicated Pi session for the workflow
- the pane shows one unified live workflow view

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
