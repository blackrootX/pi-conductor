# planv6.md

# pi-conductor v6 plan

## Scope: EASY track only

This plan covers the next **easy / low-risk** upgrades for `pi-conductor`, based on the current runtime shape:

- orchestrator-owned workflow state
- structured subagent results
- work-item projection / focus
- repair retry for malformed structured output
- internal hooks / built-in includes
- sequential public workflow model preserved

The goal of v6 is to borrow the **highest-value orchestration ideas** from `oh-my-openagent` without expanding the public `/workflow` surface area.

---

## v6 goals

1. Add a real **verify stage** owned by the runtime.
2. Persist shared-state knowledge into **inspectable wisdom buckets**.
3. Tighten the **work-order prompt contract** so every step is easier to execute and validate.
4. Add **internal execution profiles** so the runtime can specialize step behavior without changing user workflow YAML.

Non-goals for v6:

- no parallel workflows
- no public DAG syntax
- no user-editable hook/include system
- no public category/skill config
- no autonomous workflow rewriting
- no verifier-agent architecture in v6
- no persistence-source refactor in v6

---

## Why this is v6

`pi-conductor` has already completed the architectural jump from sequential raw-text handoff to orchestrator-owned state and structured results. The next gains should come from making that runtime:

- more reliable
- more inspectable
- more deliberate about delegation
- more specialized internally

This mirrors the practical strengths of `oh-my-openagent`:

- verification loops
- cumulative learnings / decisions / issues / verification memory
- clearer task contracts
- internal specialization by work type

---

# 1. First-class verify stage

## Objective

Add an explicit verification phase after step execution and before step completion.

Today the runtime can parse structured results and merge them into shared state, but the system still relies too much on the worker’s own self-report. v6 should make verification a runtime responsibility.

## Verified vs unverified state model

This must be explicit before the verify stage is safe to implement.

### Canonical rule

A step result is **unverified** until the runtime-owned verify phase passes. No downstream step may consume unverified step outputs as canonical truth.

### State layers

Each step should move through these layers:

1. **raw result**: parsed `AgentResult` from the worker
2. **provisional step updates**: normalized candidate updates derived from the raw result
3. **verified step updates**: provisional updates promoted after verification succeeds
4. **canonical workflow state**: shared state after verified updates are merged

### Merge rules

- parsed worker output is stored in step artifacts immediately for debugging
- provisional updates may be attached to the current step record
- provisional updates must **not** be merged into canonical shared state before verification passes
- later step projection must read only from canonical shared state
- if verification fails, provisional updates remain inspectable in the step record but are not promoted into canonical shared state

### Exception for read-only metadata

The runtime may record non-authoritative metadata before verification, such as:

- raw agent text
- parse diagnostics
- timestamps
- attempted evidence paths

These are debug artifacts only and must not be treated as verified workflow knowledge.

## Design

After a step returns `AgentResult`, the orchestrator runs a runtime-owned verification pass.

High-level flow:

1. build work order
2. execute step agent
3. parse structured result
4. derive provisional step updates
5. run **pre-verify step-result hooks** against the provisional updates
6. run verify stage against the provisional updates and repository state
7. record verification outcome
8. if verify passes, promote verified updates into canonical shared state
9. run **post-promote committed hooks** with read-only access to verified state
10. mark step complete or fail

## Hook ordering and compatibility rule

The existing `afterStep` hook must not remain semantically ambiguous under the provisional -> verify -> promote flow.

For v6, hook behavior should be split conceptually into two phases:

1. **pre-verify step-result hook**
   - concrete v6 surface: existing `afterStep` compatibility behavior
   - runs after parse and provisional derivation
   - may patch the provisional step result
   - any mutations it makes are still **provisional** and must pass verification before promotion
2. **post-promote committed hook**
   - concrete v6 surface: new `afterPromote` hook
   - runs only after verified promotion into canonical state
   - may emit only side-channel artifacts, logs, UI signals, or derived renderings
   - must not mutate canonical workflow knowledge
   - must not rewrite `state.json` or any `canonicalStep` snapshot

Backward-compatibility rule for existing hooks:

- the current `afterStep` hook should be treated as the **pre-verify** phase unless explicitly migrated
- if a legacy hook relies on post-merge side effects, it must be migrated to the `afterPromote` committed-hook surface
- v6 must not allow a hook to patch canonical state after verification without rerunning verification

This keeps existing behavior compatible while preserving the verified/unverified boundary.

## Verification executor decision

v6 will use a **runtime-owned verification executor** as the only verification mechanism.

That means:

- verification is executed by deterministic runtime code in `pi-conductor`
- verification may invoke bounded local checks such as file reads, grep, diagnostics, or configured commands
- verification is not delegated to a second LLM agent in v6
- verifier-agent augmentation is explicitly deferred to a later plan

This decision keeps the verify stage predictable, auditable, and safe.

## Verify modes

### Read-only steps

Use lightweight checks such as:

- grep for expected symbols / strings
- read expected files / sections
- diagnostics queries
- artifact presence checks

### Write-capable steps

Use stronger checks such as:

- targeted test commands
- lint / typecheck / diagnostics
- file existence and edit confirmation
- validation of claimed changes against repository state

## Verification execution contract

The verify executor should follow a strict order:

1. collect untrusted evidence hints from the structured result
2. build checks from a runtime-owned verify plan
3. optionally bind or narrow those checks using the untrusted hints only where runtime policy allows
4. execute checks with bounded retries = 0
5. record pass / fail / not_run per check
6. compute overall verify status
7. either promote updates or fail the step

Overall verify outcome rules:

- if any check returns `fail`, overall verify status = `failed`
- if at least one check returns `pass` and no checks fail, overall verify status = `passed`
- if the runtime-owned policy explicitly marks the step class as `verify_optional` and the selected check list is empty, overall verify status = `skipped` and promotion is allowed
- if every selected check ends `not_run` and the runtime-owned policy explicitly allowed `verify_optional`, overall verify status = `skipped` and promotion is allowed
- if the runtime expected checks but the selected list is empty, overall verify status = `failed`
- if every selected check ends `not_run` and the runtime policy did not allow `verify_optional`, overall verify status = `failed`
- `not_run` is a per-check diagnostic state, not a successful overall verify outcome by itself
- `skipped` means verification was intentionally non-required under runtime policy, not that verification silently failed to run
- `verify_optional` must be resolved from stable runtime policy before worker execution, not from worker output, generated prompt text, or hook patches

The verify plan must come from a **stable runtime-owned input source**, not from free-form agent instructions.

## Stable verification policy source

Because public `workflow.yaml` remains intentionally sparse in v6, the verifier must not guess expected checks from raw step text alone.

The stable input source for verification should be, in order:

1. runtime-owned policy keyed by resolved internal execution profile
2. runtime-known step facts available before worker execution
3. runtime generic fallback policy for the step class

For v6, "runtime-known step facts" means only stable inputs such as:

- step id
- agent name
- built-in vs custom agent source
- explicit runtime safety/tool class
- fixed runtime mapping tables
- repository facts gathered deterministically before worker execution

Examples of stable verification inputs include:

- check families such as `tests`, `lint`, `diagnostics`, `file_exists`, `grep_assertions`
- allowed command groups for verification
- expected artifact kinds or target files when declared by runtime policy or other runtime-known step facts

### Runtime-owned evidence-hint schema

Worker output may still include **evidence claims**, but those claims are not a verification-policy input.

For v6, add a runtime-owned evidence-hint schema that the runtime understands and persists in step records, for example:

- claimed touched files
- claimed artifacts produced
- claimed commands run
- claimed symbols / strings / paths worth checking

Rules:

- worker-supplied evidence is **untrusted input**
- the verifier may use worker claims only to instantiate or narrow checks already permitted by runtime policy
- missing worker claims must not disable required checks
- extra worker claims must not enable new check families the runtime policy did not allow
- free-form prose must not be treated as verification policy
- if worker claims conflict with repository state, repository state wins and verification fails or records the mismatch

Non-goals for v6:

- no free-form command guessing from arbitrary agent prose
- no requirement to expand public workflow YAML just to support verification

This keeps the verifier deterministic even while the public workflow schema stays simple.

## Constraints

- max one verify pass per step
- no hidden infinite loops
- verification results must be recorded in state
- verify failure should not silently pass
- downstream projection must not use provisional-only data

## Files to change

### `src/workflow-runtime.ts`

Add:

- `verifyStep(...)`
- provisional-vs-verified promotion logic
- step lifecycle integration
- verify summary persistence
- verify failure handling

### `src/workflow-types.ts`

Add / extend:

- step verify status (`passed`, `failed`, `skipped`)
- verify diagnostics payload
- verify attempt count
- verifier-owned evidence claim schema
- provisional update shape
- promoted update shape

### `src/workflow-state.ts`

Add:

- helpers to derive provisional updates
- helpers to promote verified updates into canonical shared state
- guards to ensure downstream projection reads canonical state only

### `src/workflow-hooks.ts`

Add hook points or extend existing ones:

- legacy `afterStep` remains the pre-verify compatibility surface
- `afterPromote` as the explicit post-promote committed hook
- `afterPromote` may not mutate canonical workflow knowledge
- `afterPromote` may not rewrite `state.json` or any `canonicalStep` snapshot
- `afterPromote` may emit only side-channel artifacts, logs, UI signals, or derived renderings
- `onVerifyFailure`

### `src/workflow-prompts.ts`

Add prompt sections for:

- definition of done
- required evidence
- verification expectations

### `src/workflow-cards.ts`

Show:

- verify state
- failed check count
- concise verification summary
- whether the current step is still provisional or verified

### `src/index.ts`

Expose a final verification summary after workflow completion.

## Acceptance criteria

- every step can optionally enter a verify stage
- verification outcomes are visible in UI and persisted data
- failing verification can fail the step
- zero-check and all-`not_run` outcomes follow explicit runtime policy and never silently count as passed
- provisional updates are not visible to later steps as canonical truth
- only verified updates are merged into canonical shared state

---

# 2. Wisdom buckets

## Objective

Persist workflow knowledge into explicit buckets instead of leaving it only in merged JSON state.

The runtime already carries information like:

- decisions
- artifacts
- learnings
- blockers
- verification
- work items

v6 should make these readable and durable.

## Design

At the end of each step, render shared-state summaries to files under the run directory.

Suggested files:

- `summary.md`
- `learnings.md`
- `decisions.md`
- `issues.md`
- `verification.md`

Canonical JSON files:

- `state.json`
- `steps/01-<agent>.result.json` (representative per-step result record)

## Source-of-truth rule

Wisdom buckets are **derived artifacts**, not independent persistence sources.

For v6, the source of truth remains:

- canonical workflow state in `state.json`
- canonical per-step snapshot stored inside each per-step result record under `steps/`

The markdown bucket files are rendered views for humans and debugging. The runtime must not treat them as authoritative input when resuming or projecting later steps.

This avoids a persistence-source split before a full persistence refactor exists.

### Canonical persistence boundary

To keep `state.json` canonical-only in v6:

- `state.json` must contain only canonical shared state plus canonical step lifecycle metadata such as status, verify outcome, timestamps, and promoted summaries
- `state.json` must not embed provisional step updates, raw worker text, repaired text, parse diagnostics, or failed / unverified result payloads
- each per-step result record such as `steps/01-<agent>.result.json` may contain both canonical and debug data, but only an explicit canonical subdocument such as `canonicalStep` is authoritative
- `canonicalStep` holds the promoted per-step snapshot used for resume, projection, and source-of-truth reasoning
- sibling fields such as raw worker output, provisional updates, verifier evidence claims, per-check diagnostics, and failure context are debug / inspectability data only
- the runtime must never treat the outer per-step result document wholesale as authoritative
- if in-memory `WorkflowState` still carries richer step records, persistence must serialize a canonical projection for `state.json` instead of dumping the full in-memory object

## Failed-attempt inspectability rule

Canonical buckets should remain canonical-only, but failed or unverified step output must still remain inspectable.

For v6:

- `learnings.md`, `decisions.md`, `issues.md`, and `verification.md` remain derived from **promoted canonical state**
- failed or unverified step-only information stays outside `canonicalStep` in the per-step result record
- the runtime should also render a separate derived debug view such as `attempts.md` or `provisional.md` summarizing failed/unverified attempts

This preserves the source-of-truth model without losing the debugging context that often matters most.

## Why this matters

This creates:

- better debuggability
- better resume / restart foundations later
- inspectable workflow memory
- cleaner projection into later work orders

## Rules

- dedupe repeated learnings
- keep decisions concise and attributed to source step
- blockers / issues should explain what is missing
- verification entries should include pass/fail/not_run status
- bucket markdown is derived from canonical state only
- failed or unverified attempt details are rendered separately, not mixed into canonical buckets
- if markdown rendering fails, canonical JSON persistence still succeeds

## Files to change

### `src/workflow-runtime.ts`

Add:

- per-step persistence hooks
- bucket writers
- markdown rendering for bucket files
- explicit render-from-canonical-state behavior
- canonical `state.json` serialization that excludes provisional / failed step payloads

### `src/workflow-types.ts`

Add / extend:

- canonical persisted run snapshot types
- canonical step snapshot types separate from richer in-memory step records

### `src/workflow-state.ts`

Add normalization helpers for:

- learnings
- decisions
- blockers
- verification

### `src/index.ts`

Surface saved bucket locations or summaries on completion.

### `src/workflow-cards.ts`

Optionally show “new this step” counts for:

- learnings
- decisions
- issues
- verification

## Acceptance criteria

- every workflow run writes inspectable bucket files
- canonical source of truth remains `state.json` plus the canonical step snapshot inside each step result record
- bucket files remain derived artifacts only
- repeated noise is reduced by normalization / dedupe
- later step projection relies on canonical state, not rendered markdown buckets

---

# 3. Stronger work-order prompt contract

## Objective

Make subagent delegation more explicit and more consistent.

The runtime already builds structured work orders. v6 should make every delegated prompt clearly state:

- what to do
- what not to do
- what counts as success
- what evidence must come back
- which tools are allowed

## Design

Every work-order prompt should render the same high-level structure:

1. TASK
2. OBJECTIVE
3. CURRENT FOCUS
4. READY WORK ITEMS
5. RECENTLY RESOLVED WORK
6. CONTEXT
7. CONSTRAINTS
8. ALLOWED TOOLS
9. DEFINITION OF DONE
10. REQUIRED EVIDENCE
11. RESPONSE CONTRACT

## Why this matters

Benefits:

- fewer vague subagent responses
- easier verification
- better consistency across built-ins and custom agents
- less prompt drift

## Files to change

### `src/workflow-prompts.ts`

Refactor / extend rendering to include:

- definition-of-done sections
- evidence sections
- allowed tool summary
- stronger response instructions

### `src/workflow-prompt-composer.ts`

Use built-in fragments to compose prompt packs by step shape.

### `src/includes/`

Add reusable internal fragments such as:

- `done-criteria.md`
- `evidence-style.md`
- `verify-style.md`
- `implementation-guardrails.md`

### `src/agents.ts`

Allow built-ins to attach prompt fragments or profile-aware guidance.

## Acceptance criteria

- all built-in workflow steps use the same delegation skeleton
- every step prompt includes success criteria and evidence requirements
- allowed tools are explicit when tool policy enforcement is active
- the response contract stays machine-parseable and human-readable

---

# 4. Internal execution profiles

## Objective

Introduce internal specialization without changing user-facing workflow syntax.

The user should still be able to write simple workflows, but the runtime should be able to decide:

- this step behaves like planning
- this step behaves like exploration
- this step behaves like implementation
- this step behaves like evidence gathering for later verification

## Design

Add hidden execution profiles such as:

- `planning`
- `explore`
- `implement`
- `verify-context`

A profile can influence:

- built-in prompt fragments
- runtime-owned verification strictness
- runtime-owned default evidence expectations
- runtime-owned fallback model selection only when no explicit model is set
- runtime-owned default tool allowlist only when no explicit tool policy is set

## Strict precedence rule

Internal profiles must not silently override custom agent behavior.

Precedence must be:

1. **explicit per-step runtime safety constraints**
   - hard tool-deny / hard execution safety rules owned by the runtime
2. **explicit user agent configuration**
   - user-provided agent instructions
   - explicit user model choice
   - explicit user tool declarations / policy
3. **internal profile defaults**
   - built-in fragments
   - default model fallback
   - default evidence expectations
   - default evidence/quality strictness used by runtime-owned verification planning
4. **generic runtime defaults**

## Profile stability rule

If execution profile is later used to select verification policy, profile resolution itself must be stable.

For v6:

- do not infer profile from rendered objective text
- do not infer profile from mutable shared state such as current focus, open work items, or recent step output
- derive profile only from stable step metadata and runtime-known configuration such as built-in agent identity, explicit agent source, explicit runtime safety/tool class, or a fixed runtime mapping table
- the same workflow step in the same workflow definition should resolve to the same profile across retries unless the user explicitly changed the workflow or agent config

### What profiles may do

Profiles may:

- add internal guidance fragments
- tighten evidence collection expectations for later runtime verification
- supply defaults when the user left fields unspecified
- change debug labeling and UI summaries

### What profiles may not do

Profiles may not:

- replace the chosen user agent identity
- override explicit user model selection
- override explicit user tool policy
- discard user-authored agent instructions
- silently reinterpret a custom agent as a different agent

If the runtime launches a separate internal verify pass in a future version, that must be represented as a separate runtime role, not as a silent override of the user’s chosen step agent.

## Verifier ownership rule

The `verify-context` profile is **not** the verifier. It only shapes worker-side evidence gathering so the later runtime-owned verify phase has better inputs.

That means:

- the step agent may be prompted to collect clearer evidence, list touched files, or declare candidate evidence targets
- the step agent does **not** decide verified vs unverified status
- only the runtime verification executor determines canonical verify outcome

This naming avoids sliding back into worker self-verification.

## Example

A user-defined `build` agent may still appear in workflow YAML. The runtime may assign the step the internal profile `implement` or `verify-context`, but that profile only changes runtime-owned prompt additions and policies that the user did not explicitly set. It does not replace the user’s chosen agent text, explicit model, or explicit tool policy.

## Why this matters

This gives `pi-conductor` some of the specialization gains seen in `oh-my-openagent` without exposing a larger public abstraction layer or making custom agents less predictable.

## Files to change

### `src/agents.ts`

Add internal metadata or profile inference helpers.

### `src/workflow-runtime.ts`

Resolve a profile per step and pass it into prompt composition and execution policy while respecting the precedence rule.

### `src/workflow-prompt-composer.ts`

Map profiles to built-in include bundles.

### `src/includes/`

Create profile-specific prompt fragments.

### `src/index.ts`

Show resolved profile in debug output if enabled.

## Initial profile rules

Suggested first-pass stable rules:

- built-in `plan` agent → `planning`
- built-in `build` agent → `implement`
- agents whose runtime tool policy is read-only-only → `explore`
- agents whose runtime tool policy allows write / edit / bash execution → `implement`
- `verify-context` is assigned only by an explicit runtime-owned rule for steps whose main purpose is collecting evidence for later verification
- if none of the above match, fall back to a generic profile keyed only by stable step metadata such as step id, agent name, and agent source

These rules can later be replaced by stronger runtime inference, but not by inference from generated prompt text.

## Acceptance criteria

- user workflow format remains unchanged
- runtime can assign a profile per step
- profile selection affects internal prompt composition and runtime-owned defaults only
- explicit user configuration always wins over internal profile defaults
- profile resolution is deterministic from stable step metadata, not generated objective text
- profile behavior stays internal-only for v6

---

# Recommended implementation order

Implement in this order:

1. stronger work-order prompt contract
2. first-class verify stage
3. wisdom buckets
4. internal execution profiles

Reasoning:

- prompt tightening is the safest base layer
- verify stage gives immediate reliability wins
- bucket persistence improves inspectability and future reuse
- execution profiles become easier once prompt composition is standardized

---

# Cross-cutting requirements

## Backward compatibility

v6 must preserve:

- sequential public workflow model
- existing `workflow.yaml` user expectations
- existing custom markdown agents
- existing structured result parsing flow

## Failure behavior

- malformed output: existing repair retry stays intact
- verify failure: fail loudly and record why
- bucket persistence should not crash the workflow if markdown rendering fails; fallback to JSON/logging if needed
- provisional step updates must never leak into canonical downstream projection on failure

## UI expectations

Workflow cards and summary output should expose:

- current profile
- verify status
- provisional vs verified step status
- new learning / decision / issue counts
- current focus / ready work summary

## Persistence expectations

Suggested run folder structure:

```text
.pi/workflow-runs/<runId>/
  state.json
  summary.md
  learnings.md
  decisions.md
  issues.md
  verification.md
  steps/
    01-<agent>.result.json
    02-<agent>.result.json
```

In this structure:

- `state.json` is canonical
- `steps/*.result.json` contain the per-step record
- only `canonicalStep` inside each file is authoritative for canonical reasoning
- `*.md` bucket files are derived renderings only

---

# Testing checklist

## Verify stage

- read-only step can pass verification
- write step can fail verification
- verify failure is visible in state and UI
- verify outcomes persist to run artifacts
- provisional updates are not projected to later steps before verification
- verified updates are promoted correctly after verify success

## Wisdom buckets

- bucket files are written on each run
- repeated learnings are deduped
- decisions / issues / verification render correctly
- markdown bucket files match canonical JSON state

## Prompt contract

- built-in steps render the full delegated structure
- allowed tool restrictions appear correctly
- response contract remains parseable

## Execution profiles

- profiles resolve deterministically
- profiles influence prompt composition and runtime-owned defaults
- explicit user model/tools/instructions are not overridden
- public YAML does not change

---

# Deliverable summary

At the end of v6, `pi-conductor` should still feel simple from the outside, but internally it should be much closer to a mature orchestrator:

- steps are easier to delegate correctly
- results are easier to verify safely
- knowledge is easier to inspect and reuse
- runtime behavior is more specialized without surprising custom agents

This keeps the current product philosophy intact while importing the best low-risk orchestration ideas from `oh-my-openagent`.
