---
name: Wrong Types Agent
description: 123
tools: "should be array"
model: true
priority: "not a number"
readOnly: "yes"
role: 999
timeoutMs: "30000"
capabilities:
  - item1
  - item2
---

An agent with wrong field types.

This should fail validation.
