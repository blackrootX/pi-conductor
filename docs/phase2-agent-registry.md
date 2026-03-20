# pi-conductor - Phase 2 (IMPLEMENTED)

## Objective

Build a proper **AgentRegistry layer** on top of your Phase 1 foundation.

> Move from "load agents by filename/id" → "resolve agents by role/capability with precedence and diagnostics".

---

# What Phase 2 Does

Phase 2 turns your system into:

> A **discoverable, mergeable, resolvable agent registry**

It solves:

- Where agents come from
- Which agent wins (precedence)
- How conflicts are handled
- How to select an agent for a task

---

# Core Responsibilities

## 1. Agent Discovery

Load agents from:

- Built-in agents
- `~/.pi/agent/agents/*.md` (user)
- `.pi/agents/*.md` (project)

---

## 2. Source Precedence

Define priority:

```
project > user > built-in
```

---

## 3. Conflict Handling

### Same source duplicate → ERROR

- Two agents normalize to same id in same folder

### Cross source duplicate → OVERRIDE

- Project overrides user
- User overrides built-in

---

## 4. Resolution (Core Feature)

Stop relying on filenames.

Instead resolve by:

### Role

```
resolveByRole("planner")
```

### Capability

```
resolveByCapability("review")
```

---

## Resolution Rules

1. Match role or capability
2. Apply precedence
3. Higher priority wins
4. Deterministic fallback:
   - name
   - filePath

---

## 5. Registry API

```ts
class AgentRegistry {
  async loadAll(): Promise<void>;

  listAgents(): AgentSpec[];
  listErrors(): StructuredError[];
  listDiagnostics(): RegistryDiagnostic[];

  findById(id: string): AgentSpec | undefined;

  resolveByRole(role: string): AgentSpec;
  resolveByCapability(capability: string): AgentSpec;
  resolve(query: {
    id?: string;
    role?: string;
    capability?: string;
  }): AgentSpec;
}
```

---

## 6. Resolution Errors

```ts
{
  code: "AGENT_NOT_FOUND",
  message: "No agent found for role 'planner'",
  requested: { role: "planner" }
}
```

---

# Required Modules

```
src/
  index.ts
  parser.ts
  normalizer.ts
  errors.ts
  discovery.ts
  registry.ts
  types.ts
```

---

# Deliverables

- Agent discovery layer
- AgentRegistry class
- Precedence + override logic
- Role/capability resolution
- Structured errors
- Diagnostics system
- Registry-focused tests

---

# Acceptance Criteria

- Loads agents from all sources
- Correct precedence behavior
- Can resolve by role
- Can resolve by capability
- Deterministic selection
- Proper duplicate vs override handling
- Clear resolution errors

---

# Execution Plan

## Milestone 1 - Refactor Structure

- Split `index.ts`
- Add `discovery.ts`
- Add `registry.ts`

## Milestone 2 - Registry Core

- Implement `AgentRegistry`
- Load + merge agents
- Expose list APIs

## Milestone 3 - Resolution

- Implement `resolveByRole`
- Implement `resolveByCapability`
- Implement unified `resolve()`

## Milestone 4 - Stabilization

- Extract comparison logic
- Add diagnostics
- Add resolution errors
- Add full registry tests

---

# Definition of Done

Phase 2 is complete when:

- Agents load from built-in/user/project
- Precedence works (`project > user > built-in`)
- Role-based resolution works
- Capability-based resolution works
- ID lookup still works (secondary)
- Duplicate vs override handled correctly
- Missing agent returns structured error
- Registry tests fully cover behavior

---

# Summary

- Phase 1 = parse + normalize
- Phase 2 = discover + merge + resolve

> Phase 2 answers: **"Which agent should handle this task?"**

---

# Implementation Status: ✅ COMPLETE

Phase 2 has been fully implemented with:

### New Modules
- `src/types.ts` - Shared types for Phase 2 (ResolutionQuery, ResolutionResult, RegistryDiagnostic, etc.)
- `src/discovery.ts` - Agent file discovery from multiple sources
- `src/registry.ts` - AgentRegistry class with full resolution API

### AgentRegistry API
```typescript
// Create registry
const registry = new AgentRegistry({
  cwd: process.cwd(),
  includeBuiltIn: true,
  includeUser: true,
  includeProject: true,
});

// Load all agents
await registry.loadAll();

// Resolution methods
const result = await registry.resolveByRole("planner");
const result = await registry.resolveByCapability("code-review");
const result = await registry.resolve({ id: "my-agent" });

// List methods
const agents = await registry.listAgents();
const errors = await registry.listErrors();
const diagnostics = await registry.listDiagnostics();
const overrides = await registry.listOverrides();

// Query methods
const roles = await registry.listRoles();
const caps = await registry.listCapabilities();
const bySource = await registry.getAgentsBySource("project");

// Utility
const count = await registry.count();
const summary = await registry.summarize();
```

### Acceptance Criteria ✅
- ✅ Loads agents from built-in/user/project sources
- ✅ Correct precedence behavior (project > user > built-in)
- ✅ Role-based resolution works
- ✅ Capability-based resolution works
- ✅ ID lookup still works (secondary)
- ✅ Duplicate vs override handled correctly
- ✅ Missing agent returns structured error
- ✅ Registry tests fully cover behavior (98 tests passing)
