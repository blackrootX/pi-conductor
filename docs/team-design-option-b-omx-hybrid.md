---
title: /team design option B — omx-hybrid (durable file state + lightweight structured handoff)
updated: 2026-03-28
watches:
  - src/team-runtime.ts
  - src/teams.ts
  - docs/team-proposal.md
---

## Summary

Option B: keep pi-conductor's existing RPC subprocess model and phase loop,
but replace raw text concat handoff with durable file-based member state
(omx pattern) + a lightweight structured summary contract (not full /workflow
JSON). Workers remain autonomous. Orchestrator owns merge and projection.

## The Core Problem with Current /team

`buildPhaseOutput()` does raw text concat truncated at 64k chars.
Next phase gets a wall of labelled prose — no structure, no decisions,
no work items, no distinction between facts and opinions.

omx solves this with durable file state (inbox.md / done.json per worker).
/workflow solves this with a full structured contract and WorkflowState.

The hybrid takes the durable file idea from omx and a lightweight
structured summary from /workflow — without the full v6 machinery.

## What Changes vs Current /team

### 1. Post-hoc extraction produces `done.json` per member

Workers write prose freely — no special output format required.
After each member's RPC worker exits, the orchestrator runs an extraction
pass that converts the worker's prose output into a small structured record.

#### TeamMemberDone schema

```ts
interface TeamMemberDone {
  agent: string;
  phaseIndex: number;
  memberIndex: number;
  status: "completed" | "failed";
  extractionStatus: "extracted" | "fallback";  // was extraction successful?
  summary: string;        // 1-3 sentences; fallback: rawOutput[:400]
  decisions: string[];    // may be empty
  artifacts: string[];    // file paths mentioned; may be empty
  blockers: string[];     // may be empty
  rawOutput: string;      // full prose, truncated at 16 000 chars
}
```

#### Extraction execution contract

- **Model**: same `defaultModel` as the team run (not worker's agent model —
  extraction is orchestrator work, not agent work)
- **Mode**: `pi --mode json -p --no-session` (one-shot, no tools)
- **System prompt**: fixed extraction system prompt (not the worker's agent
  system prompt). Instructs the model to produce exactly the JSON schema above
  and nothing else.
- **User message**: the worker's `rawOutput` prefixed by:
  `"Extract a structured summary from this agent output. Return only valid JSON."`
- **Timeout**: 30 seconds hard limit (separate from the phase timeout;
  phase timeout only governs worker execution)
- **Fallback trigger**: timeout, non-zero exit, JSON parse failure, or schema
  validation failure — any of these immediately produce a fallback record:
  `{ extractionStatus: "fallback", summary: rawOutput[:400], decisions: [], artifacts: [], blockers: [] }`
- **No retry**: one attempt only. Fallback is always safe.

#### What is NOT done

- No `/workflow`-style repair loop — extraction failure is silent and safe
- No marker contract (`[TEAM_RESULT_BEGIN]`) — workers are unaware of extraction
- Worker agent model is not used for extraction (avoids cost doubling on
  expensive worker models)

### 2. Phase handoff becomes a structured WorkOrder projection

Instead of `buildPhaseOutput()` raw concat, next phase gets a projection:

```
## Team Task
<original user task>

## Prior Decisions (all phases)
- <decision from phase 0 member 0>
- <decision from phase 0 member 1>
...

## What Phase N Produced
### <agentName> (member 1 of 2)
Summary: <done.json summary>
Decisions: <bullet list or "(none)">
Files touched: <bullet list or "(none)">
Needs attention: <bullet list or "(none)">

### <agentName> (member 2 of 2)
...

## Full Outputs (for reference)
### <agentName> (member 1 of 2)
<rawOutput, proportionally truncated>

### <agentName> (member 2 of 2)
<rawOutput, proportionally truncated>
```

Total size cap: 32 000 chars. The structured header section (task + decisions
+ per-member summaries) is always included in full. The "Full Outputs"
section fills remaining capacity, with each member's rawOutput proportionally
truncated if needed. If any truncation occurs, a warning line is prepended.

### 3. Durable run directory with explicit state machine

Persist team run state to `.pi/team-runs/<runId>/`:

```
.pi/team-runs/<runId>/
  state.json
  phases/
    0-parallel/
      0-plan/done.json
      1-plan/done.json
    1-sequential/
      0-build/done.json
```

#### state.json schema

```ts
interface TeamRunState {
  runId: string;
  teamName: string;
  task: string;
  status: TeamRunStatus;
  currentPhaseIndex: number;   // 0-based; last attempted phase on failure
  startedAt: string;           // ISO 8601
  finishedAt: string | null;   // null until terminal status reached
  errorMessage: string | null; // null on success
  phases: Array<{
    kind: "parallel" | "sequential";
    agentNames: string[];
  }>;
}

type TeamRunStatus =
  | "running"    // orchestrator is active
  | "completed"  // all phases succeeded
  | "failed"     // a phase or member failed; errorMessage set
  | "aborted";   // user or signal abort
```

`abandoned` is NOT a status value. A crashed run stays `running` forever
on disk — this is intentional. The lock protocol (below) prevents a live run
from being confused with a crashed one. Human inspection of a stale
`state.json` with `status === "running"` and no `.lock` file present is
sufficient to identify it as crashed.

#### Status transitions

```
(created) → running
running   → completed  (all phases done, no errors)
running   → failed     (member/phase failure)
running   → aborted    (AbortSignal fired or user Ctrl-C)
```

The orchestrator writes `state.json` with `status: "running"` at the start
of `runTeamByName`. It overwrites `state.json` exactly once more at the end
(in `finally`), setting the terminal status, `finishedAt`, and `errorMessage`.
If the process is killed before the `finally` runs, `state.json` stays
`running` permanently — this is the correct observable state for a crashed run.

#### Single-active-run invariant + run directory creation

The run directory root `.pi/team-runs/` is created with `fs.mkdirSync(..., { recursive: true })`
at the start of `runTeamByName`. If this fails (permission error, read-only
filesystem, etc.) the run **hard-fails immediately** — it does not proceed
without the run directory. This is required because the lock also lives under
this root; running without a lock would silently allow concurrent runs.

Concurrent `/team` runs in the same working directory are explicitly out of
scope. The orchestrator enforces a single-active-run invariant using a lock
file under the same root:

```
.pi/team-runs/.lock    ← contains the runId of the active run
```

Lock protocol in `runTeamByName`:

1. Ensure `.pi/team-runs/` exists (hard-fail if it cannot be created).
2. Attempt to create `.pi/team-runs/.lock` with `O_CREAT | O_EXCL` (atomic).
   - **Lock created successfully** → write `runId` as lock content, proceed.
   - **Lock already exists** → read `.lock` to get the prior `runId`.
     - Read `.pi/team-runs/<priorRunId>/state.json`.
     - If `status === "running"` → hard-fail with:
       `"A team run is already active (runId: <priorRunId>). Wait for it to
       complete or delete .pi/team-runs/.lock to force clear."`
     - If `status` is terminal (`completed`/`failed`/`aborted`) → the lock
       is stale (crashed run that released its state but not the lock, or
       vice versa). Delete `.lock` and retry step 2 once. If retry still
       fails, hard-fail.
     - If `state.json` does not exist → lock is orphaned (run dir was
       manually deleted). Delete `.lock` and retry step 2 once.
3. Proceed with the run.
4. In `finally`: delete `.pi/team-runs/.lock`. This runs on all exit paths
   including exceptions, AbortSignal, and normal completion.

**Force-clear path (user recovery)**: the error message in step 2 explicitly
tells the user to delete `.pi/team-runs/.lock`. After deletion the next run
acquires the lock normally. The prior crashed run's `state.json` is left at
`status: "running"` — this is correct and does not need rewriting.

**runDir exposure**: `TeamRunResult` gains a `runDir: string` field (never
null — if the run directory cannot be created the run hard-fails before
returning). The `team-conductor` tool result and `team-pane.mjs` status
payload both include `runDir`.

This is inspection-only: crashed runs are not retried or resumed.
They remain on disk at `status: "running"` for manual inspection.

### 4. TeamSharedState (lightweight, not /workflow-equivalent)

A minimal shared state accumulated across phases:

```ts
interface TeamSharedState {
  allDecisions: string[];   // union-append from all completed phases
  allArtifacts: string[];   // union-append from all completed phases
  allBlockers: string[];    // replaced (not appended) by the latest phase
}
```

Passed into every WorkOrder projection. No work item tracking, no focus,
no hooks — that is /workflow territory.

### 5. Verification: before/after dirty-file snapshot, soft warning only

Reuses the exact pattern from `workflow-runtime.ts:captureRepositorySnapshot()`:

Before each phase starts, call `captureRepositorySnapshot(cwd)` → snapshot A.
This runs `git status --porcelain=v1 --untracked-files=all -z` and records
a content hash (`md5`/`sha1`) for every currently-dirty file path.

After the phase completes, call `captureRepositorySnapshot(cwd)` → snapshot B.

A file is considered "touched by this phase" if:
- It appears in snapshot B but not in snapshot A (new dirty file), OR
- It appears in both but the content hash changed (modified during phase)

This is phase-local regardless of pre-existing dirty files — pre-existing
modifications appear in both snapshots with the same hash and are excluded.
Matches the exact semantics of `collectRuntimeTouchedFiles()` in
`workflow-runtime.ts:353-369`.

Warning logic (soft, never blocks):
- If the phase contained any write-capable agent AND touched-files set is
  empty AND `allArtifacts` from done.json records is non-empty →
  emit phase-level warning: "Phase N: agents claimed file changes but
  no files were modified"
- If `allArtifacts` is also empty → no warning (agent may be read-only)
- If `git status` returns non-zero (not a git repo) → skip check silently

Warning surfaces as a yellow indicator on the phase row in team cards.
Never blocks the run.

## What Does NOT Change

- Team YAML format: unchanged
- Agent authoring: unchanged (no new frontmatter required)
- IPC: `pi --mode rpc` subprocess per member (unchanged)
- Worker lifecycle: spawned per phase, never reused (unchanged)
- Abort cascade: sibling abort on failure (unchanged)
- Phase timeout: 10 min (unchanged; extraction has its own 30s budget)
- team-pane.mjs signal handling: unchanged

## Implementation Scope

New/changed files:

| File | Change | Est. LoC delta |
|---|---|---|
| `src/team-handoff.ts` | new: `extractMemberDone()`, `buildPhaseHandoff()`, `mergePhaseIntoSharedState()` | ~200 |
| `src/team-state.ts` | new: `initTeamRunDir()`, `acquireTeamLock()`, `releaseTeamLock()`, `writeMemberDone()`, `writeTeamState()` | ~160 |
| `src/team-runtime.ts` | modify: replace `buildPhaseOutput()`, add state writes, git snapshot, shared state, extraction call | ~100 delta |
| `src/team-cards.ts` | modify: add phase-level verification warning indicator | ~30 delta |
| `src/index.ts` | modify: add `runDir` to team-conductor result rendering | ~20 delta |

Total: ~500 LoC net new. No changes to YAML schema, agent authoring,
team-pane.mjs signal handling, or team-conductor tool parameter contract.

## Trade-off vs Option A (/workflow parity)

| | Option A | Option B (this) |
|---|---|---|
| Structured contract | Hard (parse fail = repair retry) | Soft (post-hoc extraction, always fallback) |
| Worker autonomy | Constrained (must emit JSON block) | Full (workers write prose freely) |
| Shared state | Full WorkflowState (decisions, learnings, workItems, focus) | Lightweight (decisions, artifacts, blockers only) |
| Verification | Hard gate (provisional → promote) | Soft signal (git snapshot diff warning) |
| Crash resilience | In-memory state lost on crash | Run dir persists; stale detection on next launch |
| Implementation cost | ~800 LoC, multiple new files | ~500 LoC, 2 new files + small deltas |
| Risk of breaking workers | Medium (workers must output contract) | Low (no worker changes needed) |

## Key Design Invariants

- Workers never know they are in a "hybrid" system — no new system prompt injected
- Extraction is post-hoc by orchestrator, not worker-side
- Fallback always succeeds — a bad extraction produces an empty-fields done.json
- state.json has exactly 4 terminal statuses: completed / failed / aborted / running(crashed)
- `abandoned` is not a status — crashed runs stay `running` on disk permanently
- Lock root creation failure is a hard-fail, not a best-effort fallback
- runDir is always a non-null string on TeamRunResult (hard-fail before return if root can't be created)
- Stale lock detection is by terminal status check, not by background sweep
- Concurrent /team runs in same cwd are explicitly out of scope (lock enforces this)
- runDir is exposed on TeamRunResult and team-conductor result
- Soft verification warning never blocks the run
- Extraction model = defaultModel, not worker agent model
