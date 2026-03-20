# Contributing to pi-conductor

Thank you for your interest in contributing!

## Development Setup

1. Clone the repository
2. Install dependencies: `bun install`
3. Run tests: `bun test`

## Project Structure

```
pi-conductor/
├── agents/          # Built-in agent definitions
├── extensions/      # pi command extensions
├── src/             # Core library code
│   ├── errors.ts    # Error types
│   ├── parser.ts    # Markdown/YAML parser
│   ├── normalizer.ts # Agent normalization
│   └── index.ts     # Main API
└── test/            # Test files
```

## Adding a New Agent

1. Create a new `.md` file in `agents/`
2. Add YAML frontmatter with required `name` field
3. Add the agent's system prompt as markdown body

Example:
```markdown
---
name: My Agent
description: What this agent does
role: my-agent
---

You are a helpful agent that...
```

## Running Tests

```bash
bun test          # Run all tests
bun test --watch  # Watch mode
```

## Code Style

- Use TypeScript
- Follow existing patterns in the codebase
- Add tests for new functionality

## Pull Request Process

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Run tests and ensure they pass
5. Submit a pull request
