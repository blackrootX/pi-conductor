# /workflow v3 Tasks

> 目标：在不改变 workflow YAML 和 agent authoring 方式的前提下，把当前 `/workflow` 的 orchestrator 升级成更通用的 state-driven task progression engine。

`v3` 不包含 config、hooks、includes、teams、team-workflow、DAG、resume、自动选 agent、auto-skip。

---

## 里程碑总览

- M1：work-item data model
- M2：generic objective builder
- M3：result parsing + merge
- M4：projection + UI + persistence
- M5：docs + manual validation

---

## M1 - work-item data model

### 1. 扩展核心类型

- [x] 在 `src/workflow-types.ts` 新增 `WorkItem`
- [x] 在 `SharedState` 增加 `workItems`
- [x] 在 `AgentResult` 增加可选字段：
  - [x] `newWorkItems`
  - [x] `resolvedWorkItems`
  - [x] `focusSummary`
- [x] 在 `WorkOrder` 增加：
  - [x] `agentDescription`
  - [x] `openWorkItems`
  - [x] `recentResolvedWorkItems`
  - [x] `currentFocus`

### 2. 新增 work-item helper

- [x] 新增标题归一化 helper
- [x] 新增 work-item id 生成规则
- [x] 新增 open/done/blocked work-item selector helper
- [x] 新增 recent resolved selector helper

### 验收

- [x] `WorkflowState` 能表达未完成和已完成事项
- [x] 新字段全部是 optional / backward-compatible
- [x] `npm run typecheck` 通过

---

## M2 - generic objective builder

### 3. 替换当前静态 objective 逻辑

#### 当前问题

- `defaultObjectiveForStep()` 仍然对 built-in agent 名称有静态分支
- objective 更像 role hint，不像当前 workflow 真正待推进的任务

#### 任务

- [x] 把 `defaultObjectiveForStep()` 重构成 generic objective builder
- [x] objective builder 不再按 `plan/build/...` 名字做核心逻辑分支
- [x] `buildWorkOrder()` 接收 `AgentConfig`，使用 `description` 作为专长 hint
- [x] 第一轮 objective 强调：
  - [x] 理解用户任务
  - [x] 识别当前重点
  - [x] 尽量产出 actionable work items
- [x] 后续轮 objective 强调：
  - [x] 优先推进 open work items
  - [x] 避免重复 resolved work
  - [x] 明确记录 blockers / newly discovered work / resolved work

### 验收

- [x] objective builder 不再依赖固定角色 taxonomy
- [x] 任意用户自定义 agent 都能拿到合理 objective
- [ ] built-in `plan-build` 仍然能工作

---

## M3 - result parsing + merge

### 4. 扩展 structured result parsing

#### 任务

- [x] 在 `src/workflow-result.ts` 解析 `newWorkItems`
- [x] 解析 `resolvedWorkItems`
- [x] 解析 `focusSummary`
- [x] 对这些新字段做宽松校验
- [x] 字段缺失时继续兼容原有 `v2` agent result

### 5. 扩展 merge 逻辑

#### 任务

- [x] 在 `src/workflow-state.ts` 合并 `newWorkItems`
- [x] 合并 `resolvedWorkItems`
- [x] 更新 work-item `status / updatedAt`
- [x] 当 blocker 与现有 work item 明显对应时，允许更新为 `blocked`
- [x] 重复出现的 `newWorkItems` 不能把已有 blocked work item 静默改回 `open`
- [x] 保留原有 `summary / decisions / artifacts / learnings / blockers / verification` merge 行为
- [x] `focusSummary` 写入 shared state 的 focus 字段
- [x] 当后续 step 没有继续确认旧 focus，或旧 focus 对应事项已解决时，focus 需要回退到基于 unresolved work 的推导

### 6. 保持 repair retry 兼容

- [x] 更新 structured response contract 示例
- [x] 更新 repair prompt，让 repair 也支持 work-item 可选字段
- [x] parse 失败时仍然只做一次 repair retry
- [x] repair 失败仍然 fail fast

### 验收

- [x] work-item 字段存在时会被成功 parse + merge
- [ ] work-item 字段缺失时 workflow 仍然正常运行
- [ ] repair retry 能覆盖扩展后的 contract

---

## M4 - projection + UI + persistence

### 7. 升级 projection / work order

#### 任务

- [x] `buildWorkOrder()` 优先投影 open work items
- [x] 投影 recent resolved work items
- [x] 投影 current focus
- [x] blocked work items 仍然要保留在 unresolved projection 中
- [x] 保留原有 summary / decisions / artifacts / learnings / blockers / verification
- [x] 对 work-item 列表做裁剪，避免 prompt 无限增长

### 8. 升级 UI 展示

#### 任务

- [x] 在 workflow cards 顶部增加 open/done/blocked work-item count
- [x] 在 step 展示里增加 current focus
- [x] 在 step 展示里增加 top pending work-item 摘要
- [x] 保持 `/workflow` 命令入口和 Zellij 行为不变

### 9. 升级调试落盘

#### 任务

- [x] 在 `state.json` 保存 merged `workItems`
- [x] 在 step result 文件里保存解析出的 work-item 更新
- [x] 在 step result 文件里保存 `focusSummary`
- [x] 保持现有 raw/repaired text 与 parsed result 落盘

### 验收

- [x] 下一步收到的是更偏 action-oriented 的 projection
- [x] UI 能体现 work-item progression
- [x] 落盘文件能解释 work-item 是怎么变化的

---

## M5 - docs + manual validation

### 10. 更新文档

- [x] 新增 `docs/planv3.md`
- [x] 新增 `docs/taskv3.md`
- [x] 如有必要，在 `README.md` 只补一小段 `v3 next` 说明
- [x] 说明 `v3` 继续保持 workflow YAML 不变
- [x] 说明 `v3` 不要求 agent 新 frontmatter
- [x] 说明 work-item 字段是 soft contract
- [x] 说明 `v3` 不做：
  - [x] auto-skip
  - [x] auto-reorder
  - [x] dynamic step insertion
  - [x] config/hooks/includes
  - [x] teams / team-workflow

### 11. 手工验证矩阵

- [x] `npm run typecheck`
- [ ] built-in `plan-build` 在没有 work-item 字段时仍可运行
- [ ] 单步用户自定义 workflow 在没有 work-item 字段时仍可运行
- [x] 某个 review-like agent 产出 `newWorkItems` 后，下一步能收到这些事项
- [x] 某个后续 step 产出 `resolvedWorkItems` 后，shared state 会把对应事项标记为 `done`
- [x] unresolved work items 会持续出现在后续 objective / projection 中
- [x] blocked work item 在后续 projection 中不会消失
- [x] 已解决 work item 不会继续因为 stale focus 出现在后续 objective 里
- [ ] parse failure 仍会触发一次 repair retry
- [ ] blocked status 仍会停止 workflow
- [ ] Zellij 渲染路径不崩
- [ ] 非 Zellij 渲染路径不崩

### 验收

- [ ] 至少走通一组 built-in workflow
- [ ] 至少走通一组多步用户自定义 workflow
- [x] 至少验证一组 `newWorkItems -> resolvedWorkItems` 链路
- [ ] 至少验证一组 repair retry 场景

---

## Future v4 candidates

`v3` 完成后，再考虑这些能力：

- config loader
- hooks
- includes / skills
- auto-skip
- auto-reorder
- dynamic step insertion

---

## 推荐 PR 切分

### PR 1 - Work-item model

- [x] `workflow-types`
- [x] helper / selector

### PR 2 - Generic objective builder

- [x] objective builder
- [x] `buildWorkOrder` 更新

### PR 3 - Parse + merge

- [x] result parsing
- [x] work-item merge
- [x] repair prompt 更新

### PR 4 - Projection + UI + persistence

- [x] projection
- [x] workflow cards / result rendering
- [x] debug persistence

### PR 5 - Docs + manual validation

- [x] docs
- [x] manual validation matrix

---

## Done Definition

只有同时满足下面几条，才能算 `/workflow v3` 完成：

- [x] workflow YAML 保持不变
- [x] agent frontmatter 保持不变
- [x] objective builder 已不再依赖硬编码角色
- [x] shared state 已支持通用 work items
- [x] structured result 已支持可选 work-item 更新
- [x] projection 已优先体现 open work items
- [ ] 老 agent 在不输出 work-item 字段时仍可继续跑
- [ ] repair retry / blocked / Zellij / 非 Zellij 路径都保持可用
- [ ] 文档和手工验证已补齐

---

## 最后的执行顺序建议

按下面顺序做，阻力最小：

1. `workflow-types`
2. objective builder
3. result parsing
4. merge
5. projection
6. UI / persistence
7. docs
8. 手工验证

这样能先把 orchestrator intelligence 的内核做出来，再补展示层和收尾文档。
