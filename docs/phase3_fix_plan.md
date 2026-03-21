# Phase 3 Fix Plan Checklist (pi-conductor)

## Goal
Ship a real execution runtime for Phase 3.

## Current Status
- TypeScript build is passing via `npm run build`.
- Phase 3 runtime/status fixes have been merged into the implementation.
- The follow-up fixes from the separate `tasks.md` review have been folded into this document.
- Tests were intentionally removed from the repo, so test-related checklist items are informational only until a new test strategy is added.

---

## 1. Runner Contract
- [x] Define SessionRunner interface
- [x] Define StepResultEnvelope structure
- [x] Add runId / stepId / timestamps / status fields

Integrated fixes:
- Aligned the runner contract around `StepStatus` and optional `error`.
- Preserved a single `sessionId` across scheduler, runner, progress events, and final step results.

Files:
- src/runtime/childSessionRunner.ts
- src/workflow/types.ts

---

## 2. Local Process Runner
- [ ] Replace DefaultSessionRunner stub
- [x] Spawn child process
- [x] Capture stdout/stderr
- [x] Return structured result

Integrated fixes:
- `LocalProcessRunner` now invokes the child process runtime, captures process output, and reads structured results from `result.json`.
- `DefaultSessionRunner` remains as the non-process fallback/stub implementation.

Files:
- src/runtime/childSessionRunner.ts

---

## 3. Structured Output Channel
- [x] Write result.json per step
- [x] Separate logs vs structured output

Integrated fixes:
- Session context and structured outputs are written under `.pi/workflows/...`.
- Runtime falls back to stdout parsing when structured output is unavailable.

Files:
- src/runtime/childSessionRunner.ts
- src/runtime/contextBuilder.ts

---

## 4. Status Semantics
- [x] pending / running / succeeded / failed / cancelled / timed_out
- [x] Workflow-level status aggregation

Integrated fixes:
- Removed stale `completed` usage from the runtime and command layers.
- Progress events and workflow result formatting now reflect the new status model.

Files:
- src/runtime/orchestrator.ts
- src/runtime/scheduler.ts
- src/workflow/types.ts

---

## 5. Failure Policy
- [x] abort behavior
- [x] continue-on-failure
- [x] skip dependents

Integrated fixes:
- Failure handling is aligned with dependency gating and workflow policy.
- Dependents continue to be blocked when required upstream steps fail.

Files:
- src/runtime/scheduler.ts

---

## 6. Timeout & Cancellation
- [x] Step timeout
- [x] Workflow cancel()
- [x] Kill child process

Integrated fixes:
- Step-level timeout and cancellation are surfaced through step status.
- Workflow timeout/cancellation now propagates into active running sessions.
- Scheduler actively calls `runner.cancelStep(sessionId)` for live sessions when the workflow is aborted.

Files:
- src/runtime/orchestrator.ts
- src/runtime/scheduler.ts
- src/runtime/childSessionRunner.ts

---

## 7. End-to-End Tests
- [ ] sequential workflow
- [ ] parallel workflow
- [ ] failure case
- [ ] timeout case
- [ ] cancellation case

Status note:
- The previous tests were removed from the repository. Reintroduce a replacement test strategy if end-to-end verification is needed again.

Files:
- test/workflow.test.ts

---

## 8. Command Alignment
- [x] Ensure /team and /workflow match README

Integrated fixes:
- `/team` progress output now matches the new workflow status model.
- `/workflow` command implementation has been added to inspect available workflows.

Files:
- src/extension/commands/team.ts
- src/extension/commands/workflow.ts

---

## 9. Observability Hooks
- [x] step started / completed / failed events
- [x] workflow lifecycle events

Integrated fixes:
- `step:pending`, `step:running`, `step:start`, and `step:complete` are now wired.
- `workflow:timeout` and `workflow:cancelled` are connected to live scheduler control paths.

Files:
- src/runtime/orchestrator.ts
- src/runtime/scheduler.ts

---

## 10. Backend Abstraction (prep for zellij)
- [x] Extract SessionRunner interface
- [x] Ensure local runner works independently

Integrated fixes:
- Session execution remains abstracted behind `SessionRunner`.
- Local process execution and non-process fallback execution are both available behind the same contract.

Files:
- src/runtime/childSessionRunner.ts

---

## Done when:
- [x] Real child execution works
- [ ] All tests pass
- [x] Ready to add zellij backend

Open note:
- `All tests pass` is currently unresolved because the tests were removed from the repository rather than repaired.
