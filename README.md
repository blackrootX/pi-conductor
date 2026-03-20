# pi-conductor

A pi agent package providing multi-agent orchestration with basic commands.

## Commands

### `/hello`

Says hello or prefill an agent's frontmatter.

```bash
/hello              # Says hello
/hello coder        # Prefills the editor with coder agent's frontmatter
/hello planner      # Prefills the editor with planner agent's frontmatter
```

Agents are resolved in precedence order: **project → user → built-in**

## Installation

```bash
pi install git:github.com/blackrootX/pi-conductor
```

Or from the repository URL:

```bash
pi install https://github.com/blackrootX/pi-conductor
```

## Built-in Agents

### planner
Analyzes requirements and creates detailed implementation plans.

### coder
Implements code based on specifications and plans.

### reviewer
Reviews code and provides constructive feedback.

## Agent Format

Agents are markdown files with YAML frontmatter:

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

### Supported Frontmatter Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | string | ✅ | Agent display name |
| `description` | string | | Brief description |
| `role` | string | | Agent role identifier |
| `tools` | string[] | | Available tools |
| `model` | string | | Model to use |
| `capabilities` | string[] | | List of capabilities |
| `priority` | number | | Agent priority |
| `readOnly` | boolean | | Read-only agent |
| `timeoutMs` | number | | Timeout in milliseconds |
| `tags` | string[] | | Tags for categorization |

## License

MIT
