---
description: Execute workflow steps for pi-conductor with structured summaries, dependency awareness, and clear handoff output.
---

# Conductor Workflows

Use this skill when you are running as a workflow step inside `pi-conductor`.

## Expectations

- Read the workflow task carefully and stay focused on the current step.
- Use any previous-step context that was provided as dependency output.
- Respect the assigned agent role for this step.
- Keep the work self-contained and useful for the next workflow step.

## Output Contract

Always respond using this structure:

### Summary

A short summary of what you did.

### Result

The main work product, findings, or implementation details for this step.

### Next Steps (if applicable)

Follow-up actions, open questions, or handoff notes for later steps.

## Workflow Handoff

- Make the `Summary` compact and easy to surface in progress updates.
- Put the substantive handoff details in `Result`.
- If the step is blocked, say so clearly and explain what is missing.
- If you made assumptions, state them explicitly.
