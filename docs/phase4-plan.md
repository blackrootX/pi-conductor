# Phase 4 Plan: Sequential Workflow Execution

## Goal
Turn `/workflow` into the canonical execution path for sequential subagents.

---

## Scope
- Execute workflows (not just inspect)
- Use real runner (LocalProcessRunner)
- Sequential execution first (no parallel UX yet)
- Clean CLI output
- Persist results for debugging

---

## Architecture Changes

### 1. `/workflow run`
Add execution command:
```
/workflow run <workflow-id> --task "..."
```

### 2. Use LocalProcessRunner
- Replace DefaultSessionRunner in execution path
- Optionally keep flag:
  - `--runner=local-process`

### 3. Sequential First
- Enforce maxParallelism = 1
- Strict dependency ordering
- Pass outputs step → next step

### 4. CLI UX
- Step start / complete logs
- Status (success/fail)
- Final synthesis output

### 5. Persistence
- Store run artifacts:
  - step results
  - logs
  - final output

### 6. Future (Not in Phase 4)
- zellij integration
- parallel UX improvements
