# pi-conductor v7 plan

## Scope

`v7` should stay small.

It contains only two upgrades:

- dependency-aware work items
- base-profile vs resolved-profile policy

It should not add any new public workflow syntax.

---

## Non-goals

- no public DAG syntax
- no semantic retry / re-verify loop
- no verifier-agent architecture
- no duplicate-title disambiguation model
- no acceptance-rule sublanguage
- no shared-state hook seeding for work items
- no change to the public sequential `/workflow` model

---

## Core rules

`v7` should follow three simple rules:

1. The runtime owns canonical state.
2. The runtime owns derived state.
3. Invalid dependency authoring should fail fast and become diagnostics, not clever merge logic.

That means:

- workers and hooks may author input state
- the runtime persists canonical work items
- the runtime derives `readyWorkItems`, `blockedWorkSummary`, and `currentFocus`
- workers and hooks must not patch derived fields directly

For `v7`, any hook or compatibility surface that still exposes direct patch fields for derived state should be removed or ignored by the runtime.

---

# 1. Resolved profile policy

## Objective

Keep the hidden profile system from `v6`, but make runtime policy able to choose a final internal execution posture for a step without changing user YAML or agent names.

## Model

Introduce two terms:

- `baseProfile`
  - the default profile inferred from stable step metadata
- `resolvedProfile`
  - the final runtime-owned profile for this execution of the step

`resolvedProfile` may differ from `baseProfile`, but only through a small static runtime policy table.

## Allowed inputs

For `v7`, resolved-profile policy may use only:

- step id
- agent name
- built-in vs custom agent source
- runtime tool class such as read-only vs write-capable

For `v7`, it must not use:

- repository facts
- rendered objective text
- current focus
- ready work or blocked summaries
- prior step prose
- worker output from the current step

This keeps profile resolution easy to reason about and stable before execution begins.

## Boundary

`resolvedProfile` may affect only internal posture, such as:

- prompt includes
- evidence expectations
- verification strictness
- runtime default model when the user did not set one
- runtime default tools when the user did not set them

It may not:

- change user-visible step identity
- reinterpret the selected agent as a different agent
- override explicit user model choice
- override explicit user tool policy
- discard user-authored agent instructions

## Acceptance criteria

- user `workflow.yaml` stays unchanged
- explicit user model / tool / instruction choices still win
- runtime can resolve a step to `verify-context` even when the agent name is `build`
- resolved profile changes internal posture only
- custom agents remain as predictable as they were in `v6`

---

# 2. Dependency-aware work items

## Objective

Choose the next step from ready work, not generic unresolved work.

## Authoring model

For `v7`, work items may be authored only through:

- worker structured result
- `afterStep` hook patch

For `v7`, work items may not be authored through:

- `beforeWorkflow`
- `beforeStep`
- shared-state hook seeding
- raw canonical `workItems` patches

This is the whole authoring contract:

- `newWorkItems`
- `resolvedWorkItems`
- `blockedByTitles` on `newWorkItems`

Hooks must use the same authoring contract as workers.

For `v7`, `blockers` remain narrative-only workflow output. They may explain why progress is blocked, but they must not create, update, or infer work-item `blocked` status.

## Step result status rule

For `v7`, authored structured step results should use only:

- `success`
- `failed`

`blocked` is deprecated as an authored step-result status. It must not directly create workflow or step `blocked` state.

If a worker result or `afterStep` patch still yields `status: "blocked"` for backward compatibility, the runtime should:

- record diagnostics
- normalize that authored status to `failed` for orchestration
- avoid treating worker-authored `blocked` as evidence for canonical blocked work

Workflow `blocked` status is runtime-owned. In `v7`, it should arise only from otherwise valid canonical work-item state where unresolved work exists and the ready queue is empty.

## Canonical model

Canonical `WorkItem` state should remain small.

Add only:

- `blockedBy`
  - array of canonical work-item ids

The runtime resolves `blockedByTitles` into canonical `blockedBy` ids during promotion.

Only canonical ids are stored.

## Derived state

The runtime must derive, not accept, these fields:

- `readyWorkItems`
- `blockedWorkSummary`
- `currentFocus`

Workers and hooks must not patch any of those directly.

For `v7`, this means hook/context patch surfaces should not accept derived-state overrides such as:

- `currentFocus`
- `openWorkItems`
- `readyWorkItems`
- `blockedWorkSummary`

If `focusSummary` or another free-form note is retained, it is non-authoritative. It may be stored as narrative context, but it must not override runtime-derived `currentFocus`.

## Title rule

Normalized work-item titles must be unique.

`v7` should not try to support duplicate-title ambiguity.

Rules:

- canonical state must not contain multiple work items with the same normalized title
- a `newWorkItem` matching an existing normalized title updates or reopens that item
- if duplicate normalized titles are detected in canonical state, dependency resolution must stop and record diagnostics

## Batch validity rule

For `v7`, the worker result plus the `afterStep` patch form one combined authoring batch.

The runtime must validate that combined batch before promotion.

Validation must happen before any deduping or merge behavior that would otherwise hide collisions.

`afterStep` is not an override escape hatch for conflicting work-item authoring.

Within that combined batch, the runtime must reject ambiguous work-item authoring.

Invalid cases:

- the same normalized title appears more than once in `newWorkItems`
- the same normalized title appears more than once in `resolvedWorkItems`
- the same normalized title appears in both `newWorkItems` and `resolvedWorkItems`

For `v7`, these are invalid authoring errors.

The runtime should:

- record diagnostics
- reject the entire step result as a validation failure
- avoid promoting any part of that step result into canonical state
- stop the workflow immediately with `failed` status
- avoid applying order-dependent merge behavior

## Dependency validity rule

After canonical title resolution, the runtime must treat these as invalid dependency states:

- unresolved title ref
- self-dependency
- dependency cycle
- duplicate-title canonical state

For `v7`, invalid dependency states are terminal validation failures, not promotable blocked state.

If the runtime detects one of those states while validating or projecting a step, it must:

- record diagnostics
- reject the step result
- avoid promoting any part of that step result into canonical state
- stop the workflow immediately with `failed` status

`blockedWorkSummary` is only for promoted canonical blocked state. It must not be used to represent invalid authoring or invalid dependency validation failures.

## Ready / blocked rule

The runtime should derive readiness like this:

- `done` items are complete
- explicitly `blocked` items remain blocked for backward-compatible canonical state only
- `open` or `in_progress` items with unsatisfied `blockedBy` are blocked
- `open` or `in_progress` items with satisfied `blockedBy` are ready

Blocked items stay visible, but they must not drive normal next-step execution.

For `v7`, `blockers[]` must not be used to mutate a work item into explicit `blocked` status. Only canonical work-item state drives blocked-work projection.

## No-ready-work rule

If unresolved non-`done` work exists and the ready queue is empty, the runtime should stop the workflow with `blocked` status.

In that case the runtime should:

- persist diagnostics
- persist `blockedWorkSummary`
- avoid fabricating a normal actionable `currentFocus`
- avoid constructing a normal execution objective from blocked items

This rule applies only after work items exist. It does not prevent the workflow from starting before any work items have been created.

## Projection contract

`WorkOrder.context` should project:

- `readyWorkItems`
- `blockedWorkSummary`
- `recentResolvedWorkItems`
- `currentFocus`

`currentFocus` should be runtime-derived with this precedence:

1. first ready work item, when ready work exists
2. otherwise no actionable focus

Do not let free-form focus notes, worker output, or hook patches override that precedence.

## Blocked summary shape

Keep the blocked summary small.

- `blockedWorkSummary: BlockedWorkSummaryItem[]`
- each item contains:
  - `title`
  - `reason`
    - one of `explicit_blocked` or `unresolved_dependency`
  - optional `details`
  - optional `blockedByTitles`

Use `details` only for promoted blocked-state context. Do not use `blockedWorkSummary` for terminal validation failures.

## Acceptance criteria

- next-step objective is based on `readyWorkItems`, not generic unresolved work
- items with unmet dependencies do not steal focus from ready work
- runtime-derived `readyWorkItems`, `blockedWorkSummary`, and `currentFocus` cannot be patched by workers or hooks
- hook/context compatibility fields for derived state are removed or ignored by the runtime
- dependency authoring uses `blockedByTitles` externally and canonical ids internally
- unresolved refs never persist as dangling canonical edges
- duplicate-title canonical state is diagnosable invalid state
- worker output plus `afterStep` patch are validated as one combined authoring batch
- duplicate titles within that combined authoring batch are rejected deterministically
- unresolved refs, self-dependencies, cycles, and duplicate-title canonical state fail validation instead of becoming promoted blocked work
- invalid work-item authoring fails the step with `failed` status before canonical promotion rather than partially applying non-work-item state
- `blockedWorkSummary` describes only promoted canonical blocked state, not terminal validation failures
- `blockers[]` remain narrative-only and do not mutate work-item status
- worker-authored `status: "blocked"` is normalized to `failed` and does not directly create workflow `blocked` state
- if unresolved work exists but no ready work exists, the workflow stops as `blocked` only when canonical state is otherwise valid

---

## Main code paths

Primary implementation work:

- `src/agents.ts`
  - split `baseProfile` from `resolvedProfile`
  - keep resolved-profile policy static and pre-execution
- `src/workflow-types.ts`
  - add `blockedBy`
  - add `blockedByTitles`
  - define `BlockedWorkSummaryItem`
  - replace `openWorkItems` projection with `readyWorkItems` and `blockedWorkSummary`
- `src/workflow-result.ts`
  - parse `blockedByTitles`
  - keep `status: "blocked"` only as a backward-compatible input if needed, not as a distinct `v7` orchestration outcome
- `src/workflow-work-items.ts`
  - validate title uniqueness
  - resolve dependencies
  - fail validation on unresolved refs, self-dependencies, cycles, and duplicate-title canonical state
  - derive ready and blocked sets only from valid promoted canonical state
- `src/workflow-state.ts`
  - promote canonical work-item changes
  - derive `currentFocus` from ready work only
  - validate the combined worker + `afterStep` authoring batch before promotion
  - reject invalid work-item authoring or dependency validation before any canonical promotion
  - avoid persisting worker-authored `blocked` as a distinct terminal state
  - stop validation failures as `failed`, not `blocked`
- `src/workflow-runtime.ts`
  - normalize worker-authored `status: "blocked"` to `failed` with diagnostics
  - stop as `blocked` only when unresolved work exists but no ready work exists in otherwise valid canonical state
  - resolve `resolvedProfile` before work-order construction
- `src/workflow-hooks.ts`
  - remove or disable raw shared-state work-item patching for `v7`
  - remove or ignore derived-state context patch fields such as `currentFocus` and `openWorkItems`
  - allow work-item authoring only through the same structured fields used by workers
  - keep `blockers[]` narrative-only instead of letting them mutate work-item state

Presentation/rendering updates should be adapter-only:

- prompts
- cards
- presentation
- message rendering
- debug output

They should mirror runtime-derived ready / blocked state, not define it.

---

## Implementation order

1. Dependency-aware work items
2. Resolved profile policy
3. Thin prompt / renderer cleanup

---

## Manual validation

Given current repository constraints, `v7` should rely on manual validation rather than new automated tests.

Most important checks:

- run a workflow with multiple work items and verify that only ready items drive focus
- confirm blocked items remain visible but do not become actionable focus
- confirm `blockers[]` do not mutate work-item status
- confirm `blockedByTitles` resolve only against unique normalized titles
- confirm duplicate titles in one batch are rejected rather than merged
- confirm unresolved refs, self-dependencies, and cycles fail the step with `failed` status instead of appearing as promoted blocked work
- confirm worker-authored `status: "blocked"` is normalized to `failed`
- confirm unresolved-but-no-ready workflows stop as `blocked` only when canonical state is otherwise valid
- confirm a `build` step can resolve to `verify-context` without changing user-visible step identity

---

## Summary

`v7` should make `pi-conductor` better at:

- knowing what work is actually ready
- showing why other work is blocked
- choosing the right internal execution posture for the next step

It should do that with fewer contracts, fewer hook escape hatches, and a stricter runtime-owned boundary.
