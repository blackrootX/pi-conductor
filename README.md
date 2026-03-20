# pi-conductor

A pi package for loading, normalizing, and working with pi-style agents.

It currently ships:
- built-in `planner`, `coder`, and `reviewer` agents
- a `/hello` command for quickly loading agent frontmatter into the editor
- Phase 1 agent parsing and normalization utilities

## Commands

### `/hello`

Use `/hello` by itself for a simple greeting, or pass an agent ID to load that agent's frontmatter into the editor.

```bash
/hello
/hello coder
/hello planner
/hello reviewer
```

Agent lookup follows this precedence order: **project → user → built-in**.

## Installation

```bash
pi install git:github.com/blackrootX/pi-conductor
```

Or from the repository URL:

```bash
pi install https://github.com/blackrootX/pi-conductor
```

## Built-in Agents

- `planner` for planning and task breakdown
- `coder` for implementation work
- `reviewer` for code review and feedback

## Agent Format

Agents are standard markdown files with YAML frontmatter and a markdown body used as the system prompt.

```yaml
---
name: Agent Name
description: What this agent does
role: agent-role
tools:
  - read
  - write
priority: 10
---
System prompt goes here...
```

Supported frontmatter fields:
- Required: `name`
- Optional: `description`, `tools`, `model`, `role`, `capabilities`, `priority`
- Optional orchestration metadata: `readOnly`, `timeoutMs`, `tags`

## License

MIT
