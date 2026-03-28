# /workflow v7 Tasks

> 目标：在不扩大 `/workflow` 公开 authoring surface、且不新增 automated tests 的前提下，完成 `v7` SMALL track：交付 dependency-aware work items 与 base-profile / resolved-profile policy，并把 canonical state、derived state、blocked semantics 全部收回到 runtime-owned boundary。

---

## 实现状态

### M1 - Dependency-aware work item canonical model

- [ ] 在 `src/workflow-types.ts` 为 `WorkItem` 增加 `blockedBy`
- [ ] 在 `src/workflow-types.ts` 为 `NewWorkItemInput` 增加 `blockedByTitles`
- [ ] 在 `src/workflow-types.ts` 定义 `BlockedWorkSummaryItem`
- [ ] 在 `src/workflow-types.ts` 明确 `BlockedWorkSummaryItem.reason` 只允许 `explicit_blocked` 或 `unresolved_dependency`
- [ ] 在 `src/workflow-types.ts` 保留 canonical `WorkItem.status: "blocked"` 的 backward-compatible path
- [ ] 在 `src/workflow-types.ts` 把 `WorkOrder.context.openWorkItems` 替换为 `readyWorkItems` 与 `blockedWorkSummary`
- [ ] 在 `src/workflow-result.ts` 解析 `newWorkItems[].blockedByTitles`
- [ ] 在 `src/workflow-prompts.ts` 的 response contract 与 marker template 中展示 `newWorkItems[].blockedByTitles`
- [ ] 在 `src/workflow-work-items.ts` 增加 normalized title uniqueness 校验 helper
- [ ] 在 `src/workflow-work-items.ts` 增加 `blockedByTitles -> blockedBy` resolution helper
- [ ] 在 `src/workflow-work-items.ts` 增加 unresolved ref / self-dependency / cycle / duplicate-title canonical state 校验
- [ ] 在 `src/workflow-work-items.ts` 增加 runtime-owned ready / blocked projection helper
- [ ] 在 `src/workflow-work-items.ts` 保持 backward-compatible explicit `blocked` item 仍能进入 blocked projection
- [ ] canonical state 里不得保留 dangling dependency edge
- [ ] `blockedWorkSummary` 只描述 promoted canonical blocked state，不承载 validation failure

### M2 - Combined authoring batch validation

- [ ] `src/workflow-runtime.ts` 与 `src/workflow-hooks.ts` 保持 worker result + `afterStep` patch 先 merge，再作为一个 combined batch 校验
- [ ] combined batch 校验必须早于任何 dedupe / merge 行为
- [ ] 同一 normalized title 同时出现在 `newWorkItems` 多次时，整步失败
- [ ] 同一 normalized title 同时出现在 `resolvedWorkItems` 多次时，整步失败
- [ ] 同一 normalized title 同时出现在 `newWorkItems` 与 `resolvedWorkItems` 时，整步失败
- [ ] invalid authoring error 必须记录 diagnostics
- [ ] invalid authoring error 必须阻止任何 canonical promotion
- [ ] invalid authoring error 必须让 workflow 以 `failed` 结束，而不是 `blocked`

### M3 - Runtime-owned blocked semantics

- [ ] `src/workflow-state.ts` 移除或停用 blocker-driven work-item mutation
- [ ] `blockers[]` 保持 narrative-only，不能再把 work item 变成 `blocked`
- [ ] worker / hook authored `status: "blocked"` 在 `v7` 中只做 backward-compatible input
- [ ] `src/workflow-result.ts` 保留 `status: "blocked"` 仅作为 backward-compatible parse input，而不是新的 authored contract
- [ ] `src/workflow-prompts.ts` response contract 与示例只鼓励 authored `success` / `failed`
- [ ] `src/workflow-runtime.ts` 遇到 worker-authored `status: "blocked"` 时记录 diagnostics
- [ ] `src/workflow-runtime.ts` 把 worker-authored `status: "blocked"` 规范化为 orchestration-level `failed`
- [ ] worker-authored `blocked` 不能被当作 canonical blocked work 的证据
- [ ] workflow 真正的 `blocked` 状态只来自“canonical state 有 unresolved work，但 ready queue 为空”
- [ ] validation failure 与 no-ready-work blocked 必须是两条互不混淆的 runtime path

### M4 - Derived-state boundary cleanup

- [ ] `src/workflow-hooks.ts` 移除或停用 `SharedStatePatch.workItems`
- [ ] `src/workflow-hooks.ts` 禁止 `BeforeWorkflowPatch.shared` 继续 seed canonical work items
- [ ] `src/workflow-hooks.ts` 禁止 raw shared-state work-item patching 绕过 `newWorkItems` / `resolvedWorkItems` authoring contract
- [ ] `src/workflow-hooks.ts` 移除或 ignore `WorkOrderContextPatch.currentFocus`
- [ ] `src/workflow-hooks.ts` 移除或 ignore `WorkOrderContextPatch.openWorkItems`
- [ ] 如果保留 compatibility surface，也必须保证 runtime 不接受 derived-state override
- [ ] `focusSummary` 如继续保留，只能是 narrative context，不能覆盖 runtime-derived `currentFocus`
- [ ] `src/workflow-state.ts` 的 `currentFocus` 改为只从 first ready work item 派生
- [ ] 没有 ready work 时，不再 fabricated actionable focus
- [ ] `src/workflow-prompts.ts` 改用 `readyWorkItems` 与 `blockedWorkSummary` 投影，而不是 `openWorkItems`
- [ ] `src/workflow-presentation.ts` 与 `src/index.ts` 改为镜像 runtime-derived ready / blocked state，而不是自行推导旧语义

### M5 - No-ready-work stop behavior

- [ ] 当 canonical state 有 unresolved non-`done` work 且 ready queue 为空时，runtime 停在 `blocked`
- [ ] 该路径必须 persist diagnostics
- [ ] 该路径必须 persist `blockedWorkSummary`
- [ ] 该路径不能构造正常的 actionable `currentFocus`
- [ ] 该路径不能把 blocked items 包装成正常 execution objective
- [ ] 该路径只适用于 canonical state 有效时；若存在 dependency validation failure，优先走 `failed`

### M6 - Resolved profile policy

- [ ] 在 `src/agents.ts` 明确拆分 `baseProfile` 与 `resolvedProfile`
- [ ] `resolvedProfile` 只能由稳定 runtime policy table 决定
- [ ] profile resolution 只能使用 step id / agent name / built-in vs custom source / runtime tool class
- [ ] profile resolution 不得读取 repository facts
- [ ] profile resolution 不得读取 rendered objective text
- [ ] profile resolution 不得读取 current focus / ready work / blocked summary / prior step prose / current-step worker output
- [ ] `resolvedProfile` 只能影响 internal posture，而不能改变 user-visible step identity
- [ ] `resolvedProfile` 不得覆盖 explicit user model choice
- [ ] `resolvedProfile` 不得覆盖 explicit user tool policy
- [ ] `resolvedProfile` 不得丢弃 user-authored agent instructions
- [ ] `src/workflow-runtime.ts` 在 build work order 前 resolve `resolvedProfile`
- [ ] `src/workflow-runtime.ts` 用 `resolvedProfile` 驱动 verify policy、system prompt 与 work-order construction
- [ ] `src/workflow-runtime.ts` 在 step state / result record 中持久化最终 resolved profile，而不是继续只走单一旧 profile 路径
- [ ] runtime 可以把 `build` step resolve 成 `verify-context`，但外部 authoring surface 不变

### M7 - Thin adapter cleanup

- [ ] `src/workflow-types.ts`、`src/workflow-prompts.ts`、`src/workflow-presentation.ts`、`src/index.ts` 中所有 `openWorkItems` 投影改名与改义完成
- [ ] `src/workflow-cards.ts` 改为展示新的 ready / blocked summary，而不是旧 `openWorkItems` 计数语义
- [ ] `src/workflow-message-renderer.ts` 改为展示新的 ready / blocked lists 与 summary，而不是旧 `Open Work` 视图
- [ ] adapter 层只消费 runtime-derived ready / blocked state，不再定义自己的 focus / blocked 语义
- [ ] card / message / debug output 中的 blocked 信息与 canonical projection 保持一致
- [ ] 保留必要的 backward compatibility 时，也要把旧字段降级为 non-authoritative compatibility layer

---

## 手工验证

当前仓库约束下，`v7` 继续以手工验证为主，不新增 automated tests。

### 需要执行

- [ ] `npm run typecheck`
- [ ] 跑一个会产出多个 work item 的 workflow，确认 objective 只从 `readyWorkItems` 取焦点
- [ ] 验证有 unmet dependency 的 item 不会抢占 ready item 的 focus
- [ ] 验证 `blockedByTitles` 只能解析到唯一 normalized title
- [ ] 验证 worker prompt/template 已明确展示 `blockedByTitles`
- [ ] 验证 unresolved ref 会让 step 以 `failed` 停止，而不是变成 promoted blocked work
- [ ] 验证 self-dependency 会让 step 以 `failed` 停止
- [ ] 验证 dependency cycle 会让 step 以 `failed` 停止
- [ ] 验证 duplicate-title canonical state 会被诊断为 invalid
- [ ] 验证同一 combined batch 中的 duplicate `newWorkItems` 会被拒绝
- [ ] 验证同一 combined batch 中的 duplicate `resolvedWorkItems` 会被拒绝
- [ ] 验证同一 combined batch 中 title 同时出现在 `newWorkItems` 与 `resolvedWorkItems` 会被拒绝
- [ ] 验证 invalid authoring 时不会 partial promote shared state
- [ ] 验证 `blockers[]` 不会再把 work item 状态改成 `blocked`
- [ ] 验证 worker-authored `status: "blocked"` 会被规范化为 `failed`
- [ ] 验证 prompt response contract 不再把 authored `blocked` 当作正常目标状态
- [ ] 验证 backward-compatible canonical `status: "blocked"` item 仍会出现在 `blockedWorkSummary`，且 reason 为 `explicit_blocked`
- [ ] 验证 dependency-blocked item 在 `blockedWorkSummary` 中使用 `unresolved_dependency`
- [ ] 验证只有 canonical state 有 unresolved work 且无 ready work 时，workflow 才以 `blocked` 停止
- [ ] 验证 no-ready-work blocked 路径会持久化 `blockedWorkSummary`
- [ ] 验证没有 ready work 时不会 fabricated 正常 `currentFocus`
- [ ] 验证 `focusSummary` 即使保留，也不会覆盖 runtime-derived focus precedence
- [ ] 验证 hook/context patch 已无法直接改写 `currentFocus`、`readyWorkItems`、`blockedWorkSummary`
- [ ] 验证 `beforeWorkflow` / shared-state hook 已无法直接 seed canonical work items
- [ ] 验证 explicit user model / tools / instructions 不会被 `resolvedProfile` 覆盖
- [ ] 验证 cards / message renderer / debug output 与 ready / blocked projection 保持一致
- [ ] 验证 public `workflow.yaml` authoring 方式没有变化

---

## Done Definition

- [ ] canonical work item 已支持 dependency edge，但 public authoring surface 没有扩大
- [ ] runtime 已能区分 ready work 与 blocked work，而不是继续依赖 generic unresolved work
- [ ] `blockedWorkSummary` 已只描述 promoted canonical blocked state
- [ ] `blockedWorkSummary.reason` 已稳定为 `explicit_blocked` / `unresolved_dependency`
- [ ] invalid authoring 与 invalid dependency state 已稳定走 `failed`，不会伪装成 blocked canonical state
- [ ] workflow `blocked` 已成为 runtime-owned outcome，只来自 valid canonical state 下的 no-ready-work
- [ ] `blockers[]` 与 `focusSummary` 已退回 narrative-only / non-authoritative 角色
- [ ] hook / compatibility surface 已不能 patch runtime-owned derived state
- [ ] shared-state hooks 已不能绕过 structured work-item authoring contract
- [ ] `baseProfile` / `resolvedProfile` 已分离，且 resolved policy 只使用 stable metadata
- [ ] runtime 已在 work-order construction 前 resolve 并持久化最终 `resolvedProfile`
- [ ] explicit user config 优先级仍高于 internal runtime defaults
- [ ] prompt / presentation / debug output 已统一镜像新的 ready / blocked semantics
- [ ] `v7` 没有新增 automated tests，只补齐了手工验证 checklist
