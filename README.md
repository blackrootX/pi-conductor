# pi-conductor

A pi package for multi-agent orchestration with agent discovery, resolution, and workflow execution.

## Features

### Agent Parsing
- Parse and normalize agent files from markdown with YAML frontmatter
- Validate required fields and data types

### Agent Registry
- Discover agents from multiple sources (project, user, built-in)
- Resolve agents by ID, role, or capability
- Handle precedence and overrides between sources
- Track diagnostics and errors

### Workflow Runtime
- Define and execute multi-agent workflows
- Built-in workflow presets for common patterns
- Optional per-step skills for reusable specialization
- DAG-based scheduling (sequential + parallel execution)
- Synthesize results from multiple agents

### Workflow Execution
- Execute workflows via `/workflow run` command
- Use LocalProcessRunner for real execution
- Sequential execution by default (maxParallelism=1)
- Clean CLI output with step start/complete logs
- Persist run artifacts (step results, logs, final output)

### Workflow Command
- Interactive `/workflow` menu for workflow selection and management
- `/workflow settings` command for configuring workflow preferences
- Zellij multiplexer support for visible workflow execution
- Project and user settings with project override precedence
- Structured workflow updates in the main Pi session via status, widget, and workflow messages

## Built-in Agents

- `planner` - planning and task breakdown
- `coder` - implementation work
- `reviewer` - code review and feedback

## Commands

### `/hello`

Load agent frontmatter into the editor.

```bash
/hello
/hello coder
/hello planner
/hello reviewer
```

### `/team`

Run multi-agent workflows.

```bash
# List available workflows
/team --list

# Show workflow details
/team --show plan-implement-review

# Run a workflow
/team --task "Implement user authentication" --workflow-id implement-and-review

# Auto-select workflow based on task
/team "Fix the login bug"
```

### `/workflow`

Inspect and execute workflows with interactive menu and settings.

```bash
# Interactive menu
/workflow

# List available workflows
/workflow --list
/workflow list
/workflow -l

# Show workflow details
/workflow --show plan-implement-review
/workflow show plan-implement-review

# Run a workflow
/workflow run plan-implement-review --task "Implement user authentication"

# Manage configured workflows
/workflow add plan-implement-review
/workflow cleanup
/workflow cleanup sessions
/workflow cleanup runs

# Open settings menu
/workflow settings
```

When run from Pi with this extension loaded, `/workflow` reports progress in the main Pi UI:
- footer status updates while steps run
- a workflow widget showing running and recently completed steps
- one workflow message per completed step
- one final workflow result message when the run finishes

If Zellij is enabled, step execution is visible there as well. Zellij shows the live subprocesses; the main Pi session shows structured summaries.

### Workflow Skills

`pi-conductor` now ships a real packaged Pi skill, [skills/conductor-workflows.md](/Users/tree/Code/Github/pi-conductor/skills/conductor-workflows.md), the same way `pi-teams` ships [skills/teams.md](https://github.com/burggraf/pi-teams/blob/main/skills/teams.md). Workflow child sessions automatically invoke that packaged skill, and workflow steps can still add extra skill names on top.

Workflow steps can optionally declare `skills` to give a step reusable Pi playbooks without creating a brand-new agent. Agents still define the broad role; skills add specialization for a specific step.

```json
{
  "id": "review",
  "title": "Review implementation",
  "prompt": "Review the implementation for bugs and regressions.",
  "role": "reviewer",
  "skills": ["checks"]
}
```

At runtime, conductor injects those skills into the child session context and also exposes them through `PI_WORKFLOW_SKILLS` for the step process.

### Workflow Approval Gates

Workflow steps can also declare `requiresApproval: true` to pause before execution. When a workflow is run from Pi, the extension shows an approval prompt in the main Pi UI before that step starts.

```json
{
  "id": "implement",
  "title": "Implement code",
  "prompt": "Implement the requested change.",
  "role": "coder",
  "requiresApproval": true
}
```

Approval happens at the workflow layer, so it works the same way for both local and Zellij-backed execution. If a workflow is executed without a Pi approval handler, approval-gated steps are auto-approved to keep direct command execution usable.

### Workflow Cleanup

Conductor treats `.pi/workflows/sessions/` as scratch space and `.pi/workflows/runs/` as retained run history. Finished sessions are removed automatically after successful artifact persistence, and run history is pruned to the newest 20 runs.

You can also clean workflow storage manually:

```bash
/workflow cleanup
/workflow cleanup sessions
/workflow cleanup runs
```

## Built-in Workflows

| Workflow | Description | Agents |
|----------|-------------|--------|
| `plan-implement-review` | Sequential: plan → implement → review | planner → coder → reviewer |

## Workflow Settings

Workflow settings are stored in `.pi/agent/settings.json` (project) with fallback to `~/.pi/agent/settings.json` (user).

### Settings File

```json
{
  "conductorWorkflowMultiplexer": "none",
  "conductorWorkflowDisplay": "main-window"
}
```

### Settings Keys

| Key | Values | Description |
|-----|--------|-------------|
| `conductorWorkflowMultiplexer` | `"none"` (default), `"zellij"` | Backend for workflow execution |
| `conductorWorkflowDisplay` | `"main-window"`, `"split-pane"` | Display strategy (only when multiplexer is `"zellij"`) |

### Multiplexer Modes

- **`none`**: Default mode. Workflows execute in background using LocalProcessRunner.
- **`zellij`**: Visible mode. Workflow steps run in Zellij sessions/panes.

### Zellij Display Strategies

- **`main-window`**: Preferred primary workflow view when already inside Zellij.
- **`split-pane`**: Preferred side-by-side workflow view when already inside Zellij.

Outside Zellij, both display strategies fall back to starting a detached Zellij session and printing attach instructions. Split panes are only created when Pi is already running inside Zellij.

### Settings Precedence

1. Project settings (`.pi/agent/settings.json` in project root)
2. User settings (`~/.pi/agent/settings.json`)

Project settings override user settings when a key is present.

## Predefined Workflow Templates

Like `pi-teams`, `pi-conductor` supports simple reusable templates in YAML. Create `~/.pi/workflows.yaml` for user-global workflows or `.pi/workflows.yaml` in a project for project-specific workflows.

```yaml
full:
  - planner
  - coder
  - reviewer

quick-review:
  - reviewer

frontend:
  - planner
  - coder
  - reviewer
```

Each template entry becomes a sequential workflow that runs the listed agent IDs in order. Project templates override user templates, and both override built-in workflows with the same ID.

`pi-conductor` still reads the older JSON workflow template files for compatibility, but YAML is the preferred format for simple predefined workflows.

## Agent Format

Agents are markdown files with YAML frontmatter:

- project agents: `.pi/agents/*.md`
- user agents: `~/.pi/agent/agents/*.md`
- built-in agents: [agents/](/Users/tree/Code/Github/pi-conductor/agents)

```yaml
---
name: Agent Name
description: What this agent does
role: agent-role
capabilities:
  - capability-name
priority: 10
---
System prompt goes here...
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Agent display name |
| `description` | No | Brief description |
| `role` | No | Role for role-based resolution |
| `capabilities` | No | Array of capabilities for capability-based resolution |
| `priority` | No | Higher priority wins in ambiguous resolution |
| `tools` | No | Allowed tools |
| `model` | No | Preferred model |
| `tags` | No | Tags for filtering |
| `readOnly` | No | Mark as read-only |

## Agent Resolution

Agents are resolved with this precedence: **project → user → built-in**.

### Resolution APIs

```typescript
import { AgentRegistry, createRegistry } from 'pi-conductor';

// Create and load registry
const registry = await createRegistry();

// Find by ID
const agent = await registry.findById('planner');

// Resolve by role
const result = await registry.resolveByRole('coder', { allowAmbiguous: true });
if (result.success) {
  console.log(result.agent);
} else if ('ambiguous' in result) {
  console.log('Multiple matches:', result.matches);
}

// Resolve by capability
const result = await registry.resolveByCapability('code-review');
```

## Workflow APIs

```typescript
import {
  createOrchestrator,
  LocalProcessRunner,
  ZellijRunner,
  PLAN_IMPLEMENT_REVIEW,
  createCustomWorkflow,
} from 'pi-conductor';

// Using a preset with LocalProcessRunner (default)
/* eslint-disable @typescript-eslint/no-explicit-any */
const orchestrator = createOrchestrator(
  registry as any,
  new LocalProcessRunner({ workingDir: process.cwd() })
);
const result = await orchestrator.execute(PLAN_IMPLEMENT_REVIEW, userTask);

// Using ZellijRunner for visible execution
const zellijRunner = new ZellijRunner({
  workingDir: process.cwd(),
  displayStrategy: 'main-window',
  inZellijSession: Boolean(process.env.ZELLIJ),
});

const zellijOrchestrator = createOrchestrator(registry as any, zellijRunner);
const zellijResult = await zellijOrchestrator.execute(PLAN_IMPLEMENT_REVIEW, userTask);

// Creating custom workflows
const workflow = createCustomWorkflow('my-workflow', 'My Workflow', {
  description: 'A custom workflow',
  steps: [
    { id: 'step1', title: 'Step 1', prompt: 'Do this', role: 'planner' },
    { id: 'step2', title: 'Step 2', prompt: 'Do that', role: 'coder', dependsOn: ['step1'] },
  ],
  policy: { maxParallelism: 2, onStepFailure: 'abort' },
  synthesis: { strategy: 'lead' },
});

const result = await orchestrator.execute(workflow, 'User task');

// Force sequential execution
const orchestrator2 = createOrchestrator(
  registry as any,
  new LocalProcessRunner(),
  undefined, // progress callback
  { sequential: true }
);
```

## Installation

```bash
pi install git:github.com:blackrootX/pi-conductor
```

Or from the repository URL:

```bash
pi install https://github.com/blackrootX/pi-conductor
```

## License

MIT
