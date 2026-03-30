---
title: /team Command — Design Proposal (v2)
revised: 2026-03-23
supersedes: docs/team-proposal.md (v1)
---

## Relationship to Existing Roadmap

This proposal supersedes the earlier `/team` draft. It does not affect the
`/workflow` milestone, which is already shipped. `/team` is the next feature
milestone.

## Problem

`/workflow` runs agents strictly sequentially. Some tasks benefit from
**parallel, simultaneous agents**: one agent plans while another inspects the
codebase at the same time, or multiple agents tackle independent sub-tasks
concurrently. Users also want to watch agents work in a live status view.

## Architecture Context

### Why pi needs a different IPC model than opencode

opencode embeds a persistent HTTP server (`127.0.0.1:4096+`) inside each
TUI process. Subagents are new sessions on that server; IPC is HTTP REST.
Tmux panes run `opencode attach <url> --session <id>` — a TUI wired to an
existing session.

Pi has no server. Each `pi` invocation is a standalone process. The two
programmatic modes are:

- `--mode json -p --no-session` — one-shot: one CLI-arg input, one event
  stream on stdout, process exits when done. This is what `/workflow` uses.
- `--mode rpc` — long-lived subprocess with a JSONL API over stdin/stdout.
  Input: `{"type":"prompt","message":"...","id":"r1"}` to stdin.
  Output: streaming JSON events + `{"type":"agent_end"}` on stdout.
  Supports multi-turn and abort.

### Why `/team` uses `--mode rpc`

`--mode json -p` exits after one prompt. For parallel phases where the
orchestrator must collect all results before sending the next phase input,
`--mode rpc` keeps each worker process alive during a phase so the
orchestrator can abort siblings on failure without re-launching.

**Worker lifecycle (per phase/member):** A worker process is spawned fresh at
the start of every phase member assignment and terminated (or killed) when
that member's `agent_end` event is received or on failure. Workers are never
reused across phases. This guarantees each member starts from a clean,
empty conversation with no carry-over state from prior phases.

Concretely:

- Phase N starts: one `pi --mode rpc` process is spawned per member.
- Orchestrator sends `{"type":"prompt","message":"<input>","id":"r<n>"}` to
  each worker's stdin.
- Worker streams events; orchestrator waits for `{"type":"agent_end"}`.
- On `agent_end` the worker process is closed via stdin EOF or SIGTERM.
- Phase N+1 starts: new worker processes are spawned; phase N workers are
  gone.

RPC worker policy: workers run with `--no-session` (ephemeral, no persisted
history). Sessions are not user-visible and are cleaned up when the worker
process exits.

## V1 Schema (frozen)

V1 uses a **flat list of agents per phase**. No template variables. No
`task:` overrides per member. Hand-off between phases is simple
concatenation.

```yaml
# .pi/team.yaml
plan-build-parallel:
  phases:
    - parallel:
        - plan
        - plan
    - sequential:
        - build

dual-build:
  phases:
    - parallel:
        - build
        - build
```

Rules:

- `phases` is an ordered list of phase objects.
- Each phase has exactly one key: `parallel` or `sequential`.
- The value is an ordered list of agent names (strings, not objects).
- Agent names are resolved via the same `discoverAgents()` lookup as
  `/workflow` — project > global > built-in.
- No `task:` field per member in v1. All members of a phase receive the
  same input string (see Hand-off below).
- Template variables (`{{ phases[N].agentName }}`) are explicitly out of
  scope for v1.
- Validation runs before execution starts: if any referenced agent does not
  exist, the whole team fails immediately with a clear error listing the
  missing names.

## Team Discovery and Validation

Discovery follows the same precedence as workflow discovery:

1. **Built-in** teams are the baseline (defined in `src/teams.ts`).
2. **Global** teams from `~/.pi/agent/team.yaml` override built-ins by name.
3. **Project** teams from `.pi/team.yaml` override global and built-in by name.

Within a file, if the same team name appears twice the last definition wins
(standard YAML key behaviour). Across files, project > global > built-in.

Validation errors that abort immediately (before any phase runs):

| Error | Behaviour |
|---|---|
| YAML parse failure | Entire file is skipped; teams from that file are not loaded. A warning is surfaced to the user. |
| Team name is empty or non-string | Entry is silently dropped. |
| `phases` key missing or not a list | Team is dropped with a warning. |
| Phase object has no `parallel` or `sequential` key | Phase is invalid; whole team is dropped with a warning. |
| Phase `parallel` or `sequential` value is not a non-empty list of strings | Team is dropped with a warning. |
| Member name references an agent that does not exist | Whole team fails immediately at execution start with a clear error listing missing names. |

Unknown top-level YAML keys inside a team entry are ignored (forward compat).
Unknown YAML keys at the file root (i.e., unknown team names) are treated as
user-defined teams and loaded normally.

## AgentConfig → RPC Worker Mapping

Each `AgentConfig` field maps to a `pi --mode rpc` startup flag exactly as
`workflow-runtime.ts` does for `--mode json` workers:

| `AgentConfig` field | RPC worker flag | Notes |
|---|---|---|
| `model` | `--model <value>` | Applied if non-empty; otherwise the session default model is used. |
| `tools` | `--tools <comma-list>` | Applied if non-empty array; omitted if `tools` is undefined or empty. |
| `systemPrompt` | `--append-system-prompt <tempfile>` | Written to a temp file (mode 0600), passed as flag, deleted on worker exit. Same temp-file pattern as `workflow-runtime.ts`. |
| `name` | not a flag | Used only for identification in logs and UI. |
| `description` | not a flag | Not passed to the worker. |
| `source` / `filePath` | not a flag | Metadata only. |

No other per-agent runtime flags exist in v1. When the user's session has a
`--model` active, it is passed as `defaultModel` and applied only if
`agent.model` is undefined (same precedence as `/workflow`).

## Built-in Agents and Default Team

The only built-in agents are `plan` and `build` (unchanged from
`src/agents.ts`). No `inspect` agent is added.

The built-in default team uses only those two agents:

```yaml
plan-build-parallel:
  phases:
    - parallel:
        - plan
        - plan
    - sequential:
        - build
```

Two `plan` agents run in parallel (both receive the same task; their outputs
are concatenated and passed to `build`).

**Trade-off:** Running two identical `plan` agents on the same input risks
near-duplicate output, doubles cost for that phase, and grows the `build`
context proportionally. This is an intentional default because:

- It exercises the parallel execution path in the simplest way without
  requiring extra agent definitions.
- Identical inputs do not guarantee identical outputs; divergence depends on
  model temperature and prompt context.
- The concatenated plan handed to `build` is bounded by `build`'s context
  window. If both outputs are verbose, `build` will see a large prompt.

Users who want tighter cost control should define a custom team with a single
`plan` member in the first phase, or replace the built-in default by adding
`plan-build-parallel` to their `.pi/team.yaml`.

A **hand-off size guard** is enforced: the concatenated output passed to
phase N+1 is truncated to 64 000 characters (roughly 16 000 tokens at 4
chars/token). If truncation occurs, a warning line is prepended to the
concatenated string: `[WARNING: prior phase output was truncated to 64000 chars]`.
This keeps `build` context bounded regardless of how verbose the `plan`
agents are.

**Heuristic caveat:** The 64 000-character limit is a fixed heuristic, not
derived from the actual context window of `agent.model` or `defaultModel`.
It reduces the risk of overflowing the next phase's context window but does
not guarantee the prompt fits. Future work may need model-aware sizing or
earlier summarization. Users with very large per-agent outputs who hit
context-window limits should reduce the number of parallel members or
override the default team with a single-member first phase.

This is the team run by `/team "task"` when no team name is given.

User-defined teams in `.pi/team.yaml` or `~/.pi/agent/team.yaml` may
reference any agent name including custom ones not in the built-in set.

## Hand-off Between Phases

Phase N+1 receives the **labeled concatenation** of all successful outputs
from phase N:

```
## plan (step 1 of 2)

<output text>

## plan (step 2 of 2)

<output text>
```

Each section header is `## <agentName> (step <n> of <total>)`.

If phase N has only one member, the header is still included so later phases
always receive a consistent format.

The concatenated string is passed as the prompt to every member of phase N+1.

The concatenated string is truncated to 64 000 characters before being
forwarded. If truncation occurs, the string is prepended with
`[WARNING: prior phase output was truncated to 64000 chars]\n\n`. This
matches the guard described in the default team's trade-off note above.

## Phase Failure Semantics

### Per-agent failure

An agent has failed when any of these occur:

- its `pi --mode rpc` process exits with a non-zero code
- the RPC event stream emits `stopReason: "error"` or `stopReason: "aborted"`
- the agent produces no text output (empty result)

### Parallel phase: fail-fast

When one agent in a parallel phase fails:

1. The orchestrator immediately sends `{"type":"abort"}` to all sibling
   RPC processes still running.
2. The orchestrator waits up to 3 seconds for each sibling to emit
   `agent_end` or exit; after that it sends `SIGTERM`, then `SIGKILL`.
3. The whole phase is marked failed. No outputs from that phase flow forward.
4. Execution stops. The team result reports which agent failed and its error.

Partial outputs from siblings that completed before the failure are not
forwarded. Consistency is preferred over best-effort partial results.

### Sequential phase: stop on first failure

Same as `/workflow` today: if step N fails, step N+1 does not run.

### Hang / timeout

Each agent has a configurable timeout (default: 10 minutes). If exceeded:

- Treated as a failure (same abort cascade as above).
- Error message names the timed-out agent.

No per-agent timeout override in v1 YAML. One global timeout for all agents.

### User abort

**From the main session (input blocked, polling files):**
The main session cannot send a signal directly to the tmux pane. Instead it
writes an abort sentinel file to the shared temp directory:

```
<tempdir>/team-abort        ← created by main session, no content required
```

`team-pane.mjs` polls for this file on the same 250 ms tick it uses for the
redraw loop. On detection it enters the abort sequence below, then removes
the file. This is the only cross-process signalling channel while the main
session is input-blocked.

**From the tmux pane (SIGTERM / SIGHUP / SIGINT or explicit user abort):**
`team-pane.mjs` installs signal handlers for `SIGTERM`, `SIGHUP`, and
`SIGINT` (the same three as `workflow-pane.mjs`). The abort sequence is:

1. Send `{"type":"abort"}` to every RPC worker process that is still alive
   via its stdin.
2. Wait up to 3 seconds for each worker to emit `agent_end` or exit.
3. After 3 seconds send `SIGTERM` to any remaining workers; after a further
   1 second send `SIGKILL`.
4. Write `{done:true, success:false, closedByUser:true}` to `team-status.json`.
5. Exit the pane process.

Steps 2–5 apply identically whether the abort originated from a signal,
from the `team-abort` sentinel file, or from a user pressing Ctrl-C inside
the pane itself.

**If the pane crashes before writing the status file**, the 30-minute
watchdog in the main session fires (see Status and Progress File Contract).

### Summary

| Situation | Behaviour |
|---|---|
| One agent in parallel phase fails | Abort siblings immediately, stop team |
| Sequential agent fails | Stop team |
| Agent times out | Treated as failure, abort cascade |
| User aborts (main session) | Write `team-abort` sentinel; pane detects on next poll, aborts all workers, writes final status |
| User aborts (pane signal) | SIGTERM/SIGHUP/SIGINT handler aborts all workers, writes final status |
| Partial outputs from failed phase | Not forwarded |

## UI Model

### What cannot be reused unchanged

The existing `WorkflowCardPayload` shape is a flat `steps: WorkflowCardState[]`
list. `renderConnector()` draws sequential `──▶` arrows. `buildWorkflowCardPayload()`
maps `agentNames[]` to a flat `steps[]`. `workflow-pane.mjs` calls
`runWorkflowByName()` which is strictly sequential.

None of this maps to parallel phases. The following additions are needed.

### New UI payload shape (`src/team-cards.ts`)

```ts
interface TeamMemberState {
  agent: string;
  model?: string;
  status: "pending" | "running" | "done" | "error";
  elapsedMs: number;
  lastWork: string;
}

interface TeamPhaseState {
  kind: "parallel" | "sequential";
  members: TeamMemberState[];
}

interface TeamCardPayload {
  teamName: string;
  phases: TeamPhaseState[];
}
```

### Rendering rules

- Members within a `parallel` phase are rendered side-by-side (same card
  grid as `renderRows()`, no connecting arrows between them). A `∥` label
  above the row indicates parallel execution.
- A `▼` connector separates phases vertically.
- Members within a `sequential` phase use the existing `──▶` arrows.
- The `renderCard()`, `getStatusIcon()`, `getStatusText()`, and styler
  helpers from `workflow-cards.ts` are reused verbatim.
- A new `scripts/team-pane.mjs` handles the team pane lifecycle (same
  structure as `workflow-pane.mjs`: args, redraw loop, status file writes,
  close prompt). `workflow-pane.mjs` is not modified.

### Status and Progress File Contract

The same temp-directory pattern as `workflow-pane.mjs` is used:

- The orchestrator (`src/index.ts`) creates a temp dir and allocates two
  files before launching the tmux pane:
  - `team-progress.json` — written by the pane on every member state change.
  - `team-status.json` — written **once** by the pane when the run is
    completely finished (success or failure).
- The main session polls both files every 250 ms (same interval as the
  Zellij workflow path).

**Progress file** (`team-progress.json`) schema (v1):

```json
{
  "teamName": "plan-build-parallel",
  "phases": [
    {
      "kind": "parallel",
      "members": [
        {
          "agent": "plan",
          "model": "anthropic/claude-3-5-sonnet",
          "status": "running",
          "elapsedMs": 4200,
          "lastWork": "Inspecting src/auth.ts..."
        }
      ]
    }
  ]
}
```

This is the serialised form of `TeamCardPayload`. The pane writes this on
every member status change and on the periodic redraw tick.

**Status file** (`team-status.json`) schema — identical to `workflow-pane.mjs`:

```json
{
  "done": true,
  "success": true,
  "message": "<final text or error message>",
  "summary": "<truncated summary for main session display>",
  "closedByUser": false
}
```

`done: true` is the sentinel the main session polls for. `success: false` +
`closedByUser: true` is written when the user closes the pane early.

**Who owns the final write:** `team-pane.mjs` is the sole writer of both
files. The orchestrator in `src/index.ts` only reads them.

**Watchdog / pane death fallback:** The main session enforces a hard poll
timeout of 30 minutes. If `team-status.json` has not set `done: true` within
that window, the main session treats the run as failed, logs
`"Team run timed out waiting for pane status"`, and unblocks input. This
covers the case where `team-pane.mjs` crashes or the tmux pane is killed
before it can write the final status. The 30-minute wall-clock limit is
independent of per-agent timeouts; it is a safety net, not a first-class
timeout.

On SIGTERM/SIGHUP/SIGINT, `team-pane.mjs` follows the same signal handler as
`workflow-pane.mjs`: it writes `{done:true, success:false, closedByUser:true}`
to the status file before exiting, ensuring the main session is always
unblocked even when the pane is externally killed.

### Reuse table

| Piece | Reused? | Notes |
|---|---|---|
| `renderCard()` | Yes, verbatim | |
| `getStatusIcon()` / `getStatusText()` | Yes, verbatim | |
| `createThemeStyler()` / `createPlainStyler()` | Yes, verbatim | |
| `truncateText()` / `stripAnsi()` | Yes, verbatim | |
| `renderRows()` | Partially | Reused for sequential members |
| `renderConnector()` | Partially | Reused for sequential arrows only |
| `WorkflowCardPayload` / `buildWorkflowCardPayload()` | No | `/workflow` keeps these unchanged |
| `workflow-pane.mjs` | No | New `team-pane.mjs` written separately |
| `runWorkflowByName()` | No | New `runTeamByName()` in `team-runtime.ts` |
| `discoverAgents()` | Yes, unchanged | |

## `team-conductor` Tool Contract

The `team-conductor` tool is registered in `src/index.ts` alongside the
existing `conductor` tool. Contracts below are additions relative to
`conductor`.

### Parameters (TypeBox `Type.Object`)

| Field | Type | Required | Description |
|---|---|---|---|
| `team` | `string` | yes | Name of the team to run. |
| `task` | `string` | yes | Runtime task input passed to phase 1. |
| `cwd` | `string` | no | Working directory; defaults to `ctx.cwd`. |

No other parameters in v1. This matches the `conductor` parameter shape
(swap `workflow` → `team`).

### Execute return value

The tool returns `AgentToolResult<TeamRunDetails>` where:

```ts
interface TeamMemberResult {
  agent: string;
  agentSource: AgentSource | "unknown";
  phaseIndex: number;         // 0-based
  memberIndex: number;        // position within the phase
  task: string;
  exitCode: number;
  elapsedMs: number;
  lastWork: string;
  messages: Message[];
  stderr: string;
  usage: UsageStats;          // same shape as SingleResult.usage
  model?: string;
  stopReason?: string;
  errorMessage?: string;
}

interface TeamRunDetails {
  teamName: string;
  teamSource: TeamSource;     // "built-in" | "global" | "project"
  teamFilePath: string | null;
  phases: TeamPhaseState[];   // same shape as TeamCardPayload.phases
  results: TeamMemberResult[];
}
```

`content[0].text` is the **labeled concatenation of the last phase's member
outputs in member order** (same format as the hand-off string described in
Hand-off Between Phases), or an error message if `isError: true`.

If the last phase is sequential with a single member, the concatenation
contains one labeled section and is equivalent to that member's output. If
the last phase is parallel (e.g., the `dual-build` example), there is no
single "final" text: the concatenation includes all members' outputs with
`## <agentName> (step N of M)` headers. Callers must not assume a single
unstructured string when the terminal phase is parallel. This matches the
`conductor` tool contract for sequential teams while being deterministic for
parallel-terminal teams.

### `renderCall` and `renderResult`

`renderCall` displays `team-conductor <teamName>\n  <task preview>` — same
layout as `conductor`'s `buildWorkflowCallPreview`.

`renderResult` reuses `renderTeamCardLines()` for the collapsed view and a
per-phase/member breakdown for the expanded view, mirroring
`renderWorkflowResult` in structure.

## New Files

| File | Purpose | Est. LoC |
|---|---|---|
| `src/teams.ts` | Discover + load `.pi/team.yaml`, validate schema, built-in teams | ~110 |
| `src/team-runtime.ts` | Phase orchestration, RPC process lifecycle, AgentConfig→worker mapping, failure/abort, hand-off, hand-off size guard | ~320 |
| `src/team-cards.ts` | `TeamCardPayload`, `buildTeamCardPayload()`, `renderTeamCardLines()` | ~130 |
| `scripts/team-pane.mjs` | Standalone pane script (args, redraw, progress/status file writes, signal handlers, close prompt) | ~150 |
| `src/index.ts` additions | `/team` command + `team-conductor` tool registration, watchdog poll loop | ~200 |
| **Total** | | **~910 LoC** |

The higher estimate (vs. the earlier ~750) reflects the additional contracts
now frozen: tmux launch/fallback path, RPC worker lifecycle per phase,
watchdog timeout, hand-off size guard, YAML validation, and the full
`team-conductor` params/result shape.

**Validation note:** `npm run typecheck` is the only automated check. Given
the surface area (discovery, runtime orchestration, tmux launch/fallback,
pane lifecycle, UI rendering, tool rendering), the implementation plan must
include manual validation paths: at minimum a smoke-run of the default team
in a tmux session, a no-tmux fallback run, and a simulated pane-close/abort
to verify the status-file sentinel and worker cleanup.

## `/team` Command Behavior

```
/team                          → picker: list available teams
/team "task"                   → run default team (plan-build-parallel)
/team <team-name> "task"       → run named team
```

Requires tmux. If not inside tmux: run all phases sequentially (parallel
members become sequential within their phase), print a one-time warning.
No Zellij support in v1.

**Why tmux instead of Zellij here:** The existing `/workflow` pane uses
Zellij's `zellij run --direction right` to open a side pane, which is the
right fit for a single sequential progress view. `/team` intentionally uses
tmux because its design target is environments where teams are run
standalone (outside the Pi TUI) or from a tmux-native workflow; Zellij
integration would require duplicating the Zellij pane plumbing for a
parallel layout that Zellij's current pane API does not simplify. The
fallback-to-sequential behaviour keeps `/team` usable inside Zellij without
blocking it. Zellij support is explicitly deferred to a future milestone.

## IPC Summary

| Concern | `/workflow` | `/team` |
|---|---|---|
| Agent mode | `pi --mode json -p --no-session` | `pi --mode rpc --no-session` |
| Worker lifetime | One process per step, exits when done | One process per phase member, closed after `agent_end`; never reused across phases |
| Session policy | Ephemeral | Ephemeral (`--no-session`) |
| Input | CLI arg | `{"type":"prompt",...}` via stdin |
| Output | stdout event stream, process exits | stdout events; wait for `agent_end` |
| AgentConfig mapping | `--model`, `--tools`, `--append-system-prompt` | Same flags, same precedence |
| Parallel agents | Not supported | `Promise.all()` over N raw `child_process.spawn()` instances per phase; JSONL parsed directly — no new `@mariozechner/pi-*` import |
| Completion signal | Process exit code 0 | `{"type":"agent_end"}` event |
| Failure | Process exit non-zero or error event | Abort cascade (see Failure Semantics) |
| Tmux UI | Zellij pane via `workflow-pane.mjs` | Tmux pane via `team-pane.mjs` |
| Status/progress files | `workflow-status.json`, `workflow-progress.json` | `team-status.json`, `team-progress.json` (same JSON schema) |
| Main-session unblock | Status file `done: true` | Status file `done: true`; 30-min watchdog as fallback |

## Out of Scope (v1)

- Per-agent tmux panes (one shared status pane only)
- Agent-to-agent direct communication (orchestrator relays only)
- Pause/resume/retry individual agents
- Zellij support
- Template variables in task strings
- Per-agent timeout override in YAML
