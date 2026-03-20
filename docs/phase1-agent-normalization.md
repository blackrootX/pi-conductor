# Phase 1 — Agent Format Adoption & Normalization

## Objective
Adopt pi’s existing `agents/*.md` format and normalize all agent files into a unified internal `AgentSpec`.

## Scope

### In scope
- Parse markdown agent files with YAML frontmatter
- Support built-in, user, and project agents
- Normalize into `AgentSpec`
- Validate and surface structured parse errors
- Support optional orchestration metadata
- Define deterministic ID and prompt derivation rules
- Define source precedence for same-ID collisions

### Out of scope
- No agent resolution
- No registry logic
- No workflows
- No scheduling
- No execution

## Supported Sources
- Built-in agents
- ~/.pi/agent/agents/*.md
- .pi/agents/*.md

## Supported Frontmatter

### Required
- name

### Optional
- description
- tools
- model
- role
- capabilities
- priority

### Optional orchestration metadata
- readOnly
- timeoutMs
- tags

Unknown frontmatter keys should be preserved in `metadata` but must not change normalization behavior in Phase 1.
Known fields should not also appear inside `metadata`.

## Normalization Rules

### `systemPrompt`
- The markdown body after frontmatter is the source of truth for `systemPrompt`
- A valid agent must have a non-empty markdown body after trimming leading and trailing whitespace
- Missing frontmatter is invalid
- Empty frontmatter is invalid
- Empty body is invalid

### `id`
- `id` is derived from the file basename without the `.md` extension
- `id` must be lowercase kebab-case in the normalized result
- If the basename is not already kebab-case, normalize it to kebab-case
- Collapse repeated separators into a single `-`
- Trim leading and trailing separators
- If normalization produces an empty `id`, return a structured invalid-ID error
- If two different filenames normalize to the same `id` within the same source, return a structured duplicate-ID error
- Unicode characters must be preserved exactly as written
- Do not transliterate Unicode characters to ASCII
- Do not apply Unicode normalization transforms during ID derivation

### Source precedence
- Source precedence is: `project > user > built-in`
- If two or more agents normalize to the same `id`, keep only the highest-precedence source
- A project agent overrides a user or built-in agent with the same normalized `id`
- A user agent overrides a built-in agent with the same normalized `id`
- If two agents from the same source normalize to the same `id`, return a structured duplicate-ID error
- When an agent is overridden by a higher-precedence source, the lower-precedence file is ignored rather than treated as an error

### Source provenance
- `source` is one of `built-in`, `user`, or `project`
- `filePath` must be populated for user and project agents
- `filePath` should also be populated for built-in agents when a real backing file exists
- Downstream code must not rely on `filePath` being present for built-in agents

### Validation
- `name` must be a non-empty string
- `description`, `model`, and `role` must be strings when present
- `tools`, `capabilities`, and `tags` must be arrays of strings when present
- `priority` and `timeoutMs` must be numbers when present
- `readOnly` must be a boolean when present
- `priority` is preserved metadata only in Phase 1 and must not affect source precedence or collision handling
- Empty arrays are allowed
- Duplicate values in `tools`, `capabilities`, and `tags` should be deduplicated while preserving first-seen order

### Error shape
- Structured errors must include:
  - source file path when available
  - error code
  - human-readable message
  - field name when the error is field-specific
- Supported error codes for Phase 1:
  - `invalid_frontmatter`
  - `invalid_yaml`
  - `missing_required_field`
  - `invalid_field_type`
  - `empty_body`
  - `invalid_id`
  - `duplicate_id`

### `metadata`
- `metadata` contains only unknown frontmatter keys
- Unknown keys should be preserved exactly as parsed
- `metadata` must not affect validation, precedence, or normalization in Phase 1

## Internal Type

```ts
export type AgentSource = "built-in" | "user" | "project";

export interface AgentSpec {
  id: string;
  name: string;
  description?: string;
  systemPrompt: string;

  tools?: string[];
  model?: string;

  role?: string;
  capabilities?: string[];
  priority?: number;
  readOnly?: boolean;
  timeoutMs?: number;
  tags?: string[];

  source: AgentSource;
  filePath?: string;
  metadata?: Record<string, unknown>;
}
```

## Deliverables
- parser
- normalizer
- built-in agents
- test fixtures
- structured error type
- duplicate-ID detection within the same source
- precedence-based override handling across sources

## Acceptance Criteria
- valid agent → normalized AgentSpec
- invalid agent → structured error
- supports pi-compatible format
- markdown body is normalized into `systemPrompt`
- same-source duplicate normalized IDs fail deterministically
- cross-source duplicate normalized IDs resolve as `project > user > built-in`
- malformed YAML fails with a structured parse error
- empty or missing frontmatter fails with a structured parse error
- wrong field types fail with field-specific validation errors
- `priority` is preserved but does not change Phase 1 selection behavior
- unknown frontmatter is preserved in `metadata` without affecting normalization
- array fields deduplicate repeated string values while preserving order
- built-in, user, and project fixtures cover filename normalization edge cases
- built-in, user, and project fixtures all normalize with correct source provenance
