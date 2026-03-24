---
title: AGENTS.md — pi-conductor
---

# Project Rules (read first)

- **Do not write any tests.** There is no test framework in this repo.
- **Do not assume anything about requirements.** Ask clarifying questions until
  you have enough information before writing code.

# What This Repo Is

A Pi extension that adds a `/workflow` command and a `conductor` tool to the
Pi coding agent. It discovers workflow definitions from `.pi/workflow.yaml`
(project), `~/.pi/agent/workflow.yaml` (global), and built-in defaults, then
runs each named agent step sequentially using the `pi` CLI in JSON mode.

Key source files:

| File | Purpose |
|------|---------|
| `src/index.ts` | Extension entry: registers `conductor` tool and `/workflow` command |
| `src/workflow-runtime.ts` | Runs workflows step-by-step, spawns `pi` subprocesses |
| `src/workflows.ts` | Discovers and loads workflow YAML configs |
| `src/agents.ts` | Discovers and loads agent markdown configs |
| `src/workflow-cards.ts` | Renders workflow progress cards in the TUI |
| `extensions/workflow.ts` | Thin re-export used by the Pi extension loader |
| `scripts/workflow-pane.mjs` | Standalone script run inside a Zellij pane |

# Commands

```bash
# Install dependencies
npm install

# Typecheck (only validation available — no build step, no test runner)
npm run typecheck

# Install extension into Pi project-locally (for manual testing)
pi install -l .

# Remove project-local install
pi remove -l .
```

There is no linter, no formatter config, and no test runner. `npm run typecheck`
(`tsc --noEmit`) is the only automated check. Always run it after making changes.

# TypeScript Configuration

- Target: ES2022, module: NodeNext, moduleResolution: NodeNext
- `strict: true` — all strict checks are enabled; never suppress them
- `noEmit: true` — source is consumed directly as `.ts` (via Pi's runtime)
- `skipLibCheck: true`, `esModuleInterop: true`
- Source root: `src/**/*.ts` only (not `scripts/`, not `extensions/`)

# Code Style

## Imports

- Node built-ins use the `node:` protocol prefix:
  ```ts
  import * as fs from "node:fs";
  import * as path from "node:path";
  ```
- External packages use named imports; type-only imports use `import type`:
  ```ts
  import type { Message } from "@mariozechner/pi-ai";
  import { parse as parseYaml } from "yaml";
  ```
- Internal imports always use explicit `.js` extensions (NodeNext resolution):
  ```ts
  import type { WorkflowConfig } from "./workflows.js";
  import { discoverWorkflows } from "./workflows.js";
  ```
- Group order: node built-ins → external packages → internal modules.

## Naming

| Construct | Convention | Example |
|-----------|-----------|---------|
| Variables / functions | `camelCase` | `discoverWorkflows`, `buildTitle` |
| Types / interfaces | `PascalCase` | `AgentConfig`, `WorkflowDetails` |
| Type aliases | `PascalCase` | `WorkflowSource`, `AgentSource` |
| Constants (module-level) | `UPPER_SNAKE_CASE` | `DEFAULT_WORKFLOW_NAME`, `COLLAPSED_ITEM_COUNT` |
| Files | `kebab-case.ts` | `workflow-runtime.ts`, `workflow-cards.ts` |

## Functions

- Prefer named `function` declarations at module level; arrow functions for
  callbacks, inline helpers, and single-expression utilities.
- Async functions are named and declared at module level:
  ```ts
  async function runSingleAgent(...): Promise<SingleResult> { ... }
  ```
- Avoid unnecessary `async`; only mark `async` when `await` is used.

## Types

- Prefer `interface` for object shapes; `type` for unions, aliases, and
  intersection types.
- Use explicit return types on exported functions and public-facing helpers.
- Avoid `any`. Use `unknown` and narrow with type guards instead.
- TypeBox (`@sinclair/typebox`) is used for runtime parameter validation in tool
  registrations only — not for general data modeling.

## Exports

- `src/index.ts` uses a single `export default` for the extension entry function.
- All other modules use named exports only.
- Re-exports in `extensions/workflow.ts` are one-liners:
  ```ts
  export { default } from "../src/index.js";
  ```

## Error Handling

- Filesystem operations that may fail use `try/catch` with silent fallbacks
  (return `null`, `[]`, `false`, or `undefined`):
  ```ts
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
  ```
- Empty `catch { }` (no binding) is acceptable only when the error is genuinely
  irrelevant (e.g., best-effort cleanup in `finally`). Never swallow errors that
  should surface to the caller.
- Functions that may fail return a result object with `isError: boolean` and
  `errorMessage?: string` rather than throwing — see `WorkflowRunResult`.

## Formatting

- 2-space indentation, double quotes for strings.
- No trailing whitespace.
- Multiline arrays/objects use trailing commas.
- Template literals for string interpolation; avoid `+` for multi-part strings.

# Extension Patterns

- Built-in agents are declared as `const BUILT_IN_AGENTS: AgentConfig[]` in
  `src/agents.ts`. Override by placing a `.md` file with the same `name:` in
  `.pi/agents/` (project) or `~/.pi/agent/agents/` (global).
- Built-in workflows are declared as `const BUILT_IN_WORKFLOWS: WorkflowConfig[]`
  in `src/workflows.ts`.
- The `conductor` tool parameters are validated with TypeBox `Type.Object(...)`.
  Use the same pattern for any new tool parameters.
- The extension entry is always `export default function registerExtension(pi: ExtensionAPI)`.
- Tools: `pi.registerTool({ name, execute, renderCall, renderResult, ... })`.
- Commands: `pi.registerCommand(name, { handler })`.
- UI components come from `@mariozechner/pi-tui`: `Text`, `Container`, `Markdown`, `Spacer`.
- Do not import from `@mariozechner/pi-*` packages beyond what is already used.
