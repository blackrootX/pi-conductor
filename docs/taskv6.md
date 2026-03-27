# /workflow v6 Tasks

> 目标：在不扩大 `/workflow` 公开 authoring surface 的前提下，完成 `v6` EASY track：先统一 work-order prompt contract，再引入 runtime-owned verify stage、wisdom buckets、internal execution profiles，同时保持 canonical state 边界清晰且不新增 automated tests。

---

## 实现状态

### M1 - Stronger work-order prompt contract

- [x] 重构 `src/workflow-prompts.ts`，让所有 delegated prompt 使用统一骨架
- [x] prompt 结构至少稳定包含 `TASK / OBJECTIVE / CURRENT FOCUS / READY WORK ITEMS / RECENTLY RESOLVED WORK / CONTEXT / CONSTRAINTS / ALLOWED TOOLS / DEFINITION OF DONE / REQUIRED EVIDENCE / RESPONSE CONTRACT`
- [x] 为每个 step 明确写出 success criteria，而不是只给自由描述
- [x] 为每个 step 明确写出 required evidence，方便后续 verify stage 使用
- [x] 当 tool policy 生效时，在 prompt 中显式展示 allowed tools
- [x] 保持 response contract 继续 machine-parseable 且 human-readable
- [x] 新增或整理 `src/includes/done-criteria.md`
- [x] 新增或整理 `src/includes/evidence-style.md`
- [x] 新增或整理 `src/includes/verify-style.md`
- [x] 新增或整理 `src/includes/implementation-guardrails.md`
- [x] `src/workflow-prompt-composer.ts` 能按 step/profile 组合内置 fragments
- [x] `src/agents.ts` 允许 built-ins 挂接 profile-aware prompt guidance

### M2 - First-class verify stage

- [x] 在 `src/workflow-runtime.ts` 增加 `verifyStep(...)`
- [x] step result parse 成功后先生成 provisional updates，而不是直接 merge canonical shared state
- [x] verify 通过后才把 verified updates promote 到 canonical shared state
- [x] verify 失败时，provisional updates 只保留为 inspectable step data，不进入 canonical shared state
- [x] `src/workflow-types.ts` 增加 step verify status：`passed / failed / skipped`
- [x] `src/workflow-types.ts` 增加 verify diagnostics、verify attempt count、provisional/promoted update shape
- [x] `src/workflow-types.ts` 增加 runtime-owned evidence-hint schema
- [x] verify executor 只从稳定 runtime policy 选 checks，不从 worker prose、generated prompt text、hook patch 推导 policy
- [x] `verify_optional` 必须在 worker 执行前由稳定 runtime policy 决定
- [x] worker evidence claims 只能作为 untrusted hints，用来在 policy 允许时 bind/narrow checks
- [x] zero-check 与 all-`not_run` 分支严格按 runtime policy 处理，绝不默认当作 passed
- [x] 现有 `afterStep` 明确保留为 pre-verify compatibility surface
- [x] 新增 `afterPromote` committed hook
- [x] `afterPromote` 不得修改 canonical workflow knowledge
- [x] `afterPromote` 不得重写 `state.json` 或任何 `canonicalStep`
- [x] `afterPromote` 只允许输出 side-channel artifacts、logs、UI signals 或 derived renderings
- [x] 新增 `onVerifyFailure`
- [x] `src/workflow-state.ts` 增加 canonical-only projection guard，确保 downstream projection 读不到 provisional-only data
- [x] `src/workflow-cards.ts` 显示 verify state、failed check count、verify summary、provisional vs verified 状态
- [x] `src/index.ts` 在 workflow 完成后输出 final verification summary

### M3 - Wisdom buckets + canonical persistence boundary

- [x] 在 run 目录下写出 `summary.md / learnings.md / decisions.md / issues.md / verification.md`
- [x] 每个 step 结果文件统一使用 `steps/01-<agent>.result.json` 这种 per-step result record 路径模式
- [x] 每个 per-step result record 内只让 `canonicalStep` 成为 authoritative canonical snapshot
- [x] raw worker text、provisional updates、evidence hints、per-check diagnostics、failure context 都放在 `canonicalStep` 之外
- [x] runtime 绝不把外层 `steps/*.result.json` 文档整体当成 authoritative input
- [x] `state.json` 只保存 canonical workflow state 与 canonical step lifecycle metadata
- [x] `state.json` 不得嵌入 provisional step updates、raw text、repair text、parse diagnostics、failed/unverified payload
- [x] 如果内存态 `WorkflowState` 仍然更丰富，持久化时必须显式序列化 canonical projection，而不是直接 dump 全对象
- [x] `src/workflow-runtime.ts` 增加 per-step persistence hooks 与 bucket writers
- [x] `src/workflow-runtime.ts` 增加 explicit render-from-canonical-state 行为
- [x] `src/workflow-types.ts` 增加 canonical persisted run snapshot types
- [x] `src/workflow-types.ts` 增加 canonical step snapshot types，和 richer in-memory step record 分离
- [x] `src/workflow-state.ts` 增加 learnings / decisions / blockers / verification 的 normalization helpers
- [x] failed/unverified attempts 另外渲染成 `attempts.md` 或 `provisional.md` 之类的 debug view
- [x] markdown bucket 渲染失败时不能破坏 canonical JSON persistence
- [x] `src/workflow-cards.ts` 可选显示 “new this step” 计数
- [x] `src/index.ts` 输出 bucket 位置或精简摘要

### M4 - Internal execution profiles

- [x] 在 `src/agents.ts` 增加 internal metadata 或 profile inference helper
- [x] 在 `src/workflow-runtime.ts` 为每个 step resolve internal profile
- [x] profile resolution 只能使用 stable step metadata 和 stable runtime config
- [x] profile resolution 不得依赖 rendered objective text
- [x] profile resolution 不得依赖 current focus、open work items、recent step output 等 mutable shared state
- [x] built-in `plan` 默认映射到 `planning`
- [x] built-in `build` 默认映射到 `implement`
- [x] read-only tool class 默认映射到 `explore`
- [x] write/edit/bash tool class 默认映射到 `implement`
- [x] `verify-context` 只由显式 runtime rule 指派，表示为 later verify 收集 evidence，而不是 worker 自己做 verifier
- [x] profile precedence 保持：runtime safety constraints > explicit user agent config > internal profile defaults > generic runtime defaults
- [x] internal profiles 不得覆盖 explicit user model choice
- [x] internal profiles 不得覆盖 explicit user tool policy
- [x] internal profiles 不得丢弃 user-authored agent instructions
- [x] `src/workflow-prompt-composer.ts` 能把 profile 映射到内置 include bundles
- [x] `src/includes/` 增加 profile-specific fragments
- [x] `src/index.ts` 在 debug 模式下显示 resolved profile

---

## 手工验证

当前仓库约束下，`v6` 继续以手工验证为主，不新增 automated tests。

### 需要执行

- [x] `npm run typecheck`
- [ ] 跑一个 read-only step，确认 verify 可以 `passed`
- [ ] 跑一个 write-capable step，确认 verify failure 会阻止 promotion 并可见于 state/UI
- [ ] 验证 zero-check 路径只有在 runtime policy 允许 `verify_optional` 时才会 `skipped`
- [ ] 验证 all-`not_run` 路径只有在 runtime policy 允许 `verify_optional` 时才会 `skipped`
- [ ] 验证 verify failure 时 provisional updates 不会泄漏到后续 step projection
- [ ] 验证 `afterStep` 仍然是 pre-verify compatibility surface
- [ ] 验证 `afterPromote` 无法改写 `state.json` 或 `canonicalStep`
- [ ] 验证每个 step 结果文件写到 `steps/01-<agent>.result.json` 风格路径
- [ ] 验证 `canonicalStep` 之外的数据不会被 resume/projection 当成 authoritative input
- [ ] 验证 bucket markdown 始终从 canonical state 派生，不会混入 failed/provisional attempt details
- [ ] 验证 markdown bucket 渲染失败时，canonical JSON persistence 仍然成功
- [ ] 验证 profile resolution 在 retry 前后保持稳定
- [ ] 验证 explicit user model/tools/instructions 不会被 internal profile 覆盖
- [ ] 验证 public `workflow.yaml` authoring 方式没有变化

---

## Done Definition

- [x] delegated prompt skeleton 已统一
- [x] every step 的 success criteria / evidence / tool contract 已明确
- [x] verify stage 已变成 runtime-owned phase，而不是 worker self-report
- [x] zero-check / all-`not_run` / `verify_optional` 语义已稳定落地
- [x] provisional updates 永远不会作为 canonical truth 泄漏到后续 step
- [x] `state.json` 的 canonical boundary 已稳定
- [x] `steps/*.result.json` 的 authoritative boundary 已稳定，只有 `canonicalStep` 可用于 canonical reasoning
- [x] wisdom buckets 已可读、可持久化、且只来源于 canonical state
- [x] internal execution profiles 已接入，但 public YAML 没有扩大
- [x] explicit user config 优先级高于 internal profile defaults
- [x] `v6` 没有新增 automated tests，只补齐了手工验证 checklist
