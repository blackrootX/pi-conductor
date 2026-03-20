# pi-conductor

A pi package for multi-agent orchestration with agent discovery, resolution, and workflow execution.

## Features

### Phase 1: Agent Parsing
- Parse and normalize agent files from markdown with YAML frontmatter
- Validate required fields and data types

### Phase 2: Agent Registry
- Discover agents from multiple sources (project, user, built-in)
- Resolve agents by ID, role, or capability
- Handle precedence and overrides between sources
- Track diagnostics and errors

### Phase 3: Workflow Runtime
- Define and execute multi-agent workflows
- Built-in workflow presets for common patterns
- DAG-based scheduling (sequential + parallel execution)
- Synthesize results from multiple agents

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

Inspect available workflows.

```bash
/workflow list
/workflow show <workflow-id>
```

## Built-in Workflows

| Workflow | Description | Agents |
|----------|-------------|--------|
| `plan-implement-review` | Sequential: plan → implement → review | planner → coder → reviewer |
| `parallel-audit` | Parallel audit of backend, frontend, tests, docs | 4× reviewer |
| `implement-and-review` | Simple: implement → review | coder → reviewer |
| `research-and-write` | Research then write | task-analysis → coder |
| `quick-review` | Single-agent quick review | reviewer |

## Agent Format

Agents are markdown files with YAML frontmatter:

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
  DefaultSessionRunner,
  PLAN_IMPLEMENT_REVIEW,
  createCustomWorkflow,
} from 'pi-conductor';

// Using a preset
const orchestrator = createOrchestrator(registry, new DefaultSessionRunner());
const result = await orchestrator.execute(PLAN_IMPLEMENT_REVIEW, userTask);

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
