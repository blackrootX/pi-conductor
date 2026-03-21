# Phase 4 Gap Checklist (pi-conductor)

## Status Summary
Phase 4 execution is now wired through `/workflow run`, with real runner support, sequential-by-default execution, CLI progress output, and persisted artifacts.

Build status:
- [x] `npm run build` passes

Open scope:
- Tests remain intentionally open because the repo does not currently include the removed test suite.

---

## Critical Gaps (Blockers)

### 1. `/workflow run` not implemented
- [x] Add `/workflow run <workflow-id> --task "..."`
- [x] Parse CLI args and task input
- [x] Wire to orchestrator.execute()

Files:
- src/extension/commands/workflow.ts

---

### 2. Command path still uses stub runner
- [x] Replace DefaultSessionRunner usage
- [x] Use LocalProcessRunner in `/workflow run`
- [x] Optionally support `--runner` flag

Files:
- src/extension/commands/workflow.ts
- src/extension/commands/team.ts

---

### 3. Real execution not default
- [x] Ensure LocalProcessRunner is default execution backend
- [x] Remove or downgrade stub runner usage

Note:
- `DefaultSessionRunner` is still available as an explicit fallback, but real execution defaults to `LocalProcessRunner`.

Files:
- src/runtime/childSessionRunner.ts
- src/extension/commands/team.ts

---

## Execution Behavior Gaps

### 4. Sequential execution guarantee
- [x] Force maxParallelism=1 in `/workflow run`
- [x] Ensure strict dependency ordering
- [x] Validate step output passing

Note:
- Ordering is enforced by dependency resolution and scheduler behavior rather than by requiring declaration-order validation.

Files:
- src/runtime/scheduler.ts
- src/runtime/orchestrator.ts

---

### 5. CLI execution UX missing
- [x] Print workflow start
- [x] Print step start
- [x] Print step completion (success/fail)
- [x] Print final synthesized output

Files:
- src/extension/commands/workflow.ts

---

### 6. Artifact persistence incomplete
- [x] Ensure per-step result.json is saved
- [x] Ensure logs are persisted
- [x] Ensure final output is saved

Files:
- src/runtime/childSessionRunner.ts
- src/runtime/orchestrator.ts

---

## Integration Gaps

### 7. `/workflow` and `/team` inconsistency
- [x] `/workflow` should execute workflows
- [x] `/team` should remain higher-level abstraction
- [x] Align behavior with README

Files:
- src/extension/commands/workflow.ts
- src/extension/commands/team.ts
- README.md

---

### 8. Tests not covering real execution
- [ ] Add test for `/workflow run`
- [ ] Add sequential execution test
- [ ] Add failure propagation test
- [ ] Add output passing test

Files:
- test/workflow.test.ts

---

## Nice-to-Have (Post-Phase 4)

- [x] Add `--verbose` flag output
- [ ] Add run directory naming strategy
- [ ] Add resume/debug tooling
- [ ] Prepare backend abstraction for zellij

---

## Definition of Done

- [x] `/workflow run` executes real child agents
- [x] Uses LocalProcessRunner by default
- [x] Sequential workflows work end-to-end
- [x] CLI shows correct progress
- [x] Artifacts are persisted
- [ ] Tests validate real execution
