# Phase 4 Tasks Checklist

## Execution
- [x] Add `/workflow run <id>` command
- [x] Wire to orchestrator.execute()
- [x] Accept `--task` input

## Runner
- [x] Use LocalProcessRunner instead of DefaultSessionRunner
- [x] Add runner flag (optional)

## Sequential Logic
- [x] Force sequential mode (maxParallelism=1)
- [x] Validate dependency ordering
- [x] Ensure step outputs pass correctly

## CLI Output
- [x] Print workflow start
- [x] Print step start/complete
- [x] Print failures clearly
- [x] Print final result

## Persistence
- [x] Create run directory
- [x] Save per-step result.json
- [x] Save logs
- [x] Save final output

## Testing
- [ ] Sequential workflow test
- [ ] Failure propagation test
- [ ] Output passing test

## Cleanup
- [x] Align README with new command
- [x] Keep /team as higher-level abstraction

## Notes
- Build verification is passing via `npm run build`.
- The testing items remain open because the repo currently does not include the removed test suite.
