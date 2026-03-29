---
title: /meeting command — design proposal
created: 2026-03-29
status: draft
watches:
  - src/index.ts
  - src/teams.ts
  - src/team-runtime.ts
  - src/agents.ts
---

## Summary

Replace `/team` with `/meeting`. `/meeting` is the unified command for
both parallel agent execution (everything `/team` does today) and
multi-agent deliberation (review, critique, refine, debate). The command
surface, YAML format, and internal runtime all change; the underlying RPC
subprocess engine from `team-runtime.ts` is retained and reused.

## Motivation

`/team` is execution-only: same task to all parallel members, raw text
concat handoff. This works for implementation work but cannot express
deliberation — where value comes from structured disagreement, iterative
gatekeeping, and cross-critique between independent perspectives.

`/meeting` unifies both under one command. A `mode` field in the meeting
YAML selects the execution model. This is a **compatible transition**, not a
breaking rename: `/team`, `team-conductor`, and `.pi/team.yaml` are all
retained as deprecated aliases that continue to work. Nothing breaks until
users explicitly migrate.

## Compatibility Contract

This is NOT a breaking change. The following are retained unchanged:

- `/team` command: kept, marked deprecated in description text
- `team-conductor` tool: kept, marked deprecated in description text
- `.pi/team.yaml` discovery: kept; `discoverTeams()` continues to run
- All existing `TeamConfig` / `TeamRunResult` types: kept

`/meeting` is an **additive** command that runs alongside `/team`. Users
migrate by creating `.pi/meeting.yaml`. Until they do, everything works.

Deprecation timeline is out of scope for this proposal.

## YAML Schema

**New file**: `.pi/meeting.yaml` (project) or `~/.pi/agent/meeting.yaml`
(global). Discovery: project > global > built-in. Same precedence as
`workflow.yaml` and `team.yaml`.

Three modes:

```yaml
# .pi/meeting.yaml

# Mode 1: execute — same parallel/sequential phase model as team.yaml
plan-build-parallel:
  mode: execute
  phases:
    - parallel: [plan, plan]
    - sequential: [build]

# Mode 2: refine — iterative reviewer/fixer loop (proposal-refinement)
proposal-review:
  mode: refine
  rounds: 3
  reviewer:
    cli: codex              # external CLI spec (object form)
    reasoning: xhigh
  fixer:
    cli: opencode
  output: file             # file | session

# Mode 3: debate — parallel positions + cross-critique + synthesis
design-debate:
  mode: debate
  rounds: 1
  participants:
    - role: advocate
      agent: architect      # pi agent name
    - role: critic
      agent: skeptic
  output: file

quick-critique:
  mode: refine
  rounds: 3
  reviewer: plan            # pi agent name (string = pi agent only)
  fixer: build
  output: session
```

### Participant spec — two forms, unambiguous

```yaml
# Form 1: bare string → always a pi agent name, resolved via discoverAgents()
reviewer: plan

# Form 2: object → always an external CLI spec; never a pi agent
reviewer:
  cli: codex              # "codex" | "opencode"
  model: gpt-5.4          # optional
  reasoning: xhigh        # optional, codex-specific
```

Bare strings like `codex` or `opencode` are NOT valid — they would fail
agent resolution since only `plan` and `build` are built-in pi agents.
External CLIs always require the object form. This is enforced at YAML
parse time with a clear error message.

External CLI env vars are read from `process.env` — not hardcoded. If
required env vars are absent the participant is treated as unavailable and
degraded mode applies.

## Command Invocation

```
/meeting                             → picker: list available meetings
/meeting "task or topic"             → run default meeting (plan-build-parallel)
/meeting <name> "task or topic"      → named meeting
/meeting <name> "task or topic" "<file-path>"  → with artifact (refine/debate only)
```

The artifact path is a **positional third argument** — not a `--file` flag.
This keeps argument parsing consistent with `/workflow` and `/team`.

**Quoting rule**: when a file path is present as the third argument, the
task/topic MUST be quoted. The current `tokenizeCommandArgs()` helper strips
quote characters from the returned token values (see `index.ts:309-318`),
so the token array alone cannot distinguish a quoted multi-word task from an
unquoted one. The `/meeting` command handler must enforce the quoting rule
by inspecting the **raw `args` string** before tokenizing: if more than two
whitespace-separated tokens are present after an initial split and the first
non-meeting-name portion does not start with a quote character, reject with:
`"Task must be quoted when a file path is provided. Example: /meeting
proposal-review \"my topic\" path/to/file.md"`.

Alternatively, a thin wrapper around `tokenizeCommandArgs` that tracks
whether each token originated from a quoted string can enforce this without
raw string inspection — either approach is acceptable.

`<file-path>` is valid only for `mode: refine` and `mode: debate`:
- `mode: execute`: third argument is silently ignored with a warning
- `mode: refine` + `output: file` + no path: fixer writes a new file named
  `<meeting-name>-<timestamp>.md` in cwd; reviewer reads topic string only
- `mode: refine` + `output: file` + path provided: fixer refines in-place
- `mode: refine` + `output: session`: no file written at any point; the
  final reviewer verdict and fixer's last response are posted to the session
- `mode: debate` + `output: file` + path provided: synthesis written to
  `<stem>-synthesis.md`; participants read the artifact
- `mode: debate` + `output: file` + no path: synthesis written to
  `<meeting-name>-<timestamp>.md`; participants receive topic only
- `mode: debate` + `output: session`: synthesis posted to session; no file
  written; participants receive topic + artifact (if path provided)

## Default Meeting

The default meeting is `plan-build-parallel` (mode: execute) — same
behavior as `/team`'s default, so `/meeting "task"` is a drop-in.

## Three Modes

### Mode 1: `execute`

Identical to the current `/team` runtime. Phase handoff is labeled text
concat (not yet upgraded to option-B hybrid — that is a separate milestone).

**Execution ownership**: `meeting-runtime.ts` does NOT delegate to
`runTeamByName()`. It calls `runTeamPhases()` — a new exported function
extracted from `team-runtime.ts` that accepts an injected `TeamConfig`
and `AgentConfig[]` directly instead of doing its own discovery. This
avoids the `discoverTeams()` / `discoverAgents()` mismatch where
`meeting.yaml` definitions would be invisible to the team runtime.

```ts
// New export in team-runtime.ts
export async function runTeamPhases(
  cwd: string,
  teamConfig: TeamConfig,       // injected — no internal discovery
  agents: AgentConfig[],        // injected — no internal discovery
  task: string,
  defaultModel?: string,
  signal?: AbortSignal,
  onUpdate?: TeamUpdateCallback,
  options?: TeamRuntimeOptions,
): Promise<TeamRunResult>
```

`runTeamByName()` is refactored to call `runTeamPhases()` after its own
discovery step — preserving the existing `/team` path unchanged.

All existing `/team` semantics: fail-fast, sibling abort, 10-min timeout,
tmux worker panes.

### Mode 2: `refine`

Iterative review/fix loop. The reviewer gates; the fixer iterates.

```
Round N:
  reviewer → reads topic [+ artifact] → structured verdict (READY / NOT_READY)
  if READY → stop, success
  fixer    → reads artifact [+ verdict] → updates artifact → confirms
  repeat up to config.rounds
```

Termination conditions:

| Condition | Action |
|---|---|
| Reviewer verdict = READY (0 blockers) | Stop, success |
| `config.rounds` reached, still NOT_READY | Stop, report remaining blockers |
| Same blockers 2 rounds in a row | Hard stop: "stuck — needs human input" |
| Participant unavailable | Degraded mode (see below) |

Reviewer uses the 9-dimension assessment from `proposal-refinement`:
Problem Understanding, Completeness, Technical Approach, Assumptions & Risks,
Scope Appropriateness, Workload Size, Contract Consistency, Implementation
Readiness, Open Questions.

Reviewer output format (orchestrator parses `VERDICT:` and `BLOCKERS:`):
```
VERDICT: READY|NOT_READY
BLOCKERS: <count>
CONCERNS: <count>

## Blockers (Must Fix)
### <Dimension>
- Issue: ...
- Location: ...
- Suggestion: ...
```

If parsing fails → orchestrator treats round as NOT_READY, continues (safe).

Stuck detection: orchestrator diffs blocker list between consecutive rounds.
If identical → hard stop. Blocker identity = trimmed issue text per blocker.

#### Artifact state for `output: session` (in-memory refine)

When `output: session`, no file is read or written at any point. The
orchestrator maintains an in-memory markdown string as the current artifact:

- **Initial value**: if a file path was provided as the third argument,
  the artifact is initialized from that file's content. Otherwise
  initialized from the topic string itself.
- **After each fixer turn**: replaced entirely by the fixer's full
  response text (last assistant message from the fixer's RPC session).
- **What the reviewer reads each round**: the current in-memory artifact
  string, prepended with the original topic.
- **What is posted to session on termination**: the final artifact string
  plus a summary of rounds run and remaining blockers (if any).

This means `quick-critique` (reviewer=plan, fixer=build, output=session)
runs through up to 3 review/fix cycles entirely in memory and posts the
final refined text to the session — no filesystem involvement.

#### Artifact write contract (refine mode)

The artifact file path is passed to the fixer in its prompt as an explicit
absolute path. The fixer is instructed to write changes to that exact path.

After each fixer run, the orchestrator verifies the artifact was updated:
- Capture file content hash before fixer runs (or record file does not exist)
- After fixer completes, re-read hash
- If hash unchanged AND fixer reported no errors → treat as `no-change`

`no-change` handling:
- If this is the first no-change in this round → record it, continue to next round
- If this is the second consecutive no-change → hard stop: "fixer produced no
  changes after two rounds — stopping to prevent infinite loop"

This is NOT a degraded-retry. The fixer either changed the file or it
didn't. Two consecutive no-changes means the fixer cannot address the
remaining blockers — needs human input.

If fixer exits with error (non-zero exit or `stopReason === "error"`):
- Treat as meeting failure, stop immediately, report error.

If artifact file does not exist after fixer run AND `output: file` was
expecting in-place refinement → treat as meeting failure (fixer did not
create the expected file), stop immediately.

### Mode 3: `debate`

Three phases: parallel positions → cross-critique → orchestrator synthesis.

```
Phase 1 (parallel):
  all participants receive identical topic + optional artifact
  each produces an independent position

Phase 2 (sequential, repeated config.rounds times):
  each participant reads the other participants' Phase 1 outputs
  framed as "a colleague proposed this" — never "another AI"
  each produces a rebuttal/updated position

Phase 3 (orchestrator only):
  reconcile using R0-R7 rules from cross-model-debate methodology
  write synthesis to file or session
```

Participants: 2 minimum, 4 maximum. `role` label used in prompts and UI
only. Orchestrator owns synthesis — no participant writes the output file.

## New Types — `src/meeting.ts`

```ts
export type MeetingSource = "built-in" | "global" | "project";
export type MeetingMode = "execute" | "refine" | "debate";
export type MeetingOutputTarget = "file" | "session";

// Unambiguous: string = pi agent, object = external CLI
export type MeetingParticipantSpec =
  | string
  | { cli: "codex" | "opencode"; model?: string; reasoning?: string };

export interface MeetingExecuteConfig {
  name: string;
  mode: "execute";
  phases: Array<{ kind: "parallel" | "sequential"; agentNames: string[] }>;
  source: MeetingSource;
  filePath?: string;
}

export interface MeetingRefineConfig {
  name: string;
  mode: "refine";
  rounds: number;             // default 3, max 5
  reviewer: MeetingParticipantSpec;
  fixer: MeetingParticipantSpec;
  // "file": fixer writes/updates a file; artifact path from command arg or auto-named
  // "session": no file written; final verdict + fixer response posted to session only
  output: MeetingOutputTarget;
  source: MeetingSource;
  filePath?: string;
}

export interface MeetingDebateParticipant {
  role: string;
  agent: MeetingParticipantSpec;
}

export interface MeetingDebateConfig {
  name: string;
  mode: "debate";
  rounds: number;             // cross-critique rounds, default 1
  participants: MeetingDebateParticipant[];  // 2–4
  // "file": orchestrator writes synthesis to a file (auto-named if no artifact path)
  // "session": synthesis posted to session only; no file written
  output: MeetingOutputTarget;
  source: MeetingSource;
  filePath?: string;
}

export type MeetingConfig =
  | MeetingExecuteConfig
  | MeetingRefineConfig
  | MeetingDebateConfig;
```

## Worker Execution Model

### Pi agents — new lower-level process primitive

`createWorker()` in `team-runtime.ts` is tightly coupled to team-shaped
metadata — it takes `task`, `phaseIndex`, `memberIndex`, `onUpdate` and
returns `RpcWorkerHandle` whose `result` field is `TeamMemberResult`. This
coupling is correct for `/team` but wrong for `/meeting` refine/debate,
where participants are not "members of a phase" and progress updates are
session messages rather than per-slot card state.

**Solution**: extract a new lower-level primitive into `team-runtime.ts`
that owns only subprocess startup and RPC message parsing. Both
`createWorker()` and `meeting-runtime.ts` use it:

```ts
// New export in team-runtime.ts
export interface RpcProcess {
  // Send a prompt and wait for agent_end
  run(task: string, signal?: AbortSignal): Promise<RpcProcessResult>;
  // Abort a running prompt
  abort(reason: string): void;
}

export interface RpcProcessResult {
  messages: Message[];
  exitCode: number;
  stderr: string;
  usage: UsageStats;
  model?: string;
  stopReason?: string;
  elapsedMs: number;
  lastWork: string;  // getFinalOutput(messages)
}

// New export — starts the pi --mode rpc process, no team metadata
export function spawnRpcProcess(
  cwd: string,
  agent: AgentConfig,
  defaultModel: string | undefined,
): RpcProcess
```

`createWorker()` is refactored to call `spawnRpcProcess()` and wrap the
result into `TeamMemberResult` — no behavior change for `/team`.

`meeting-runtime.ts` calls `spawnRpcProcess()` directly and wraps
`RpcProcessResult` into meeting-shaped result types.

`RpcProcess`, `RpcProcessResult`, and `spawnRpcProcess` are the only new
exports added to `team-runtime.ts`. `createWorker()` remains private.

### External CLIs

One-shot subprocess, stdout collected as participant output.

```ts
export type MeetingWorkerKind =
  | { kind: "pi" }
  | { kind: "external"; cli: "codex" | "opencode" };
```

External CLI invocation (env vars from `process.env`):

```bash
# codex
codex exec --full-auto "<prompt>"

# opencode
https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY no_proxy=$NO_PROXY \
AWS_PROFILE=$AWS_PROFILE AWS_REGION=$AWS_REGION \
opencode --log-level DEBUG run "<prompt>"
```

## UI Scope: Session-Only for Refine and Debate

The existing `team-pane.mjs` and `team-worker-pane.mjs` scripts are
hard-coded to team/phase/member state shapes. They cannot render rounds,
verdicts, or arbitrary participant roles without significant rewriting.

**Decision**: `mode: refine` and `mode: debate` use session-only UI in v1.
No tmux pane for these modes. Progress is posted as session messages.
`mode: execute` continues to use tmux worker panes exactly as `/team` does.

This keeps the scope honest and avoids expanding `team-pane.mjs` and
`team-cards.ts` to cover all three modes in one release.

## Degraded Mode

| Scenario | Action |
|---|---|
| External CLI unavailable (missing binary or env vars) — refine | Substitute built-in pi `plan` (reviewer) or `build` (fixer). Notify user. |
| External CLI unavailable — debate participant | Drop that participant. Proceed if 2+ participants remain. Hard fail if fewer than 2 remain after drops. |
| Pi agent not found (any mode) | Hard fail before run starts |
| Fixer produces no output (empty result) | Treat as no-change; apply no-change handling above |
| Fixer exits with error | Hard fail, stop meeting immediately |
| Synthesis write fails (file permission) | Fall back to session output. Notify user. |
| Fewer than 2 debate participants available after drops | Hard fail with message listing which participants were unavailable. |

## Built-in Defaults

```ts
const BUILT_IN_MEETINGS: MeetingConfig[] = [
  {
    name: "plan-build-parallel",  // default: /meeting "task"
    mode: "execute",
    phases: [
      { kind: "parallel", agentNames: ["plan", "plan"] },
      { kind: "sequential", agentNames: ["build"] },
    ],
    source: "built-in",
  },
  {
    name: "quick-critique",
    mode: "refine",
    rounds: 3,
    reviewer: "plan",             // pi agent, string form
    fixer: "build",               // pi agent, string form
    output: "session",
    source: "built-in",
  },
  {
    name: "proposal-review",
    mode: "refine",
    rounds: 3,
    reviewer: { cli: "codex", reasoning: "xhigh" },  // object form
    fixer: { cli: "opencode" },                       // object form
    output: "file",
    source: "built-in",
  },
];
```

## Files Changed

### New files

| File | Purpose | Est. LoC |
|---|---|---|
| `src/meeting.ts` | `MeetingConfig` types, `discoverMeetings()`, YAML parsing + validation | ~220 |
| `src/meeting-runtime.ts` | `runMeetingByName()`: dispatches to execute/refine/debate runners; external CLI; verdict parser; artifact hash check; stuck detection | ~480 |
| `src/meeting-cards.ts` | TUI cards for execute mode; session message rendering for refine/debate | ~100 |

### Modified files

| File | Change | Est. LoC delta |
|---|---|---|
| `src/team-runtime.ts` | Extract `spawnRpcProcess()` + export `RpcProcess` / `RpcProcessResult` types; extract `runTeamPhases()`; refactor `createWorker()` to call `spawnRpcProcess()` | ~60 delta |
| `src/index.ts` | Add `/meeting` command + `meeting-conductor` tool alongside existing `/team` + `team-conductor` | ~220 delta |

Total: ~800 LoC net new + ~250 delta.

### Retained fully unchanged

`teams.ts`, `team-cards.ts`, `scripts/team-pane.mjs`,
`scripts/team-worker-pane.mjs`, `/team` command, `team-conductor` tool.

### NOT removed (kept as deprecated)

- `/team` command in `index.ts`
- `team-conductor` tool in `index.ts`
- `.pi/team.yaml` discovery in `teams.ts`

## Open Questions (resolved)

1. **execute-mode delegation**: `runTeamPhases()` is extracted from
   `team-runtime.ts` and accepts injected config. No duplicate phase loop.

2. **debate synthesis**: orchestrator writes synthesis using its own
   reasoning. No separate synthesizer participant in v1.

3. **max rounds cap**: 5 for both modes.

4. **--file vs positional**: positional third argument (consistent with
   `/workflow` and `/team` arg style).
