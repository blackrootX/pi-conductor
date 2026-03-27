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

- [ ] 在 `src/workflow-types.ts` 新增 `WorkItem`
- [ ] 在 `SharedState` 增加 `workItems`
- [ ] 在 `AgentResult` 增加可选字段：
  - [ ] `newWorkItems`
  - [ ] `resolvedWorkItems`
  - [ ] `focusSummary`
- [ ] 在 `WorkOrder` 增加：
  - [ ] `agentDescription`
  - [ ] `openWorkItems`
  - [ ] `recentResolvedWorkItems`
  - [ ] `currentFocus`

### 2. 新增 work-item helper

- [ ] 新增标题归一化 helper
- [ ] 新增 work-item id 生成规则
- [ ] 新增 open/done/blocked work-item selector helper
- [ ] 新增 recent resolved selector helper

### 验收

- [ ] `WorkflowState` 能表达未完成和已完成事项
- [ ] 新字段全部是 optional / backward-compatible
- [ ] `npm run typecheck` 通过

---

## M2 - generic objective builder

### 3. 替换当前静态 objective 逻辑

#### 当前问题

- `defaultObjectiveForStep()` 仍然对 built-in agent 名称有静态分支
- objective 更像 role hint，不像当前 workflow 真正待推进的任务

#### 任务

- [ ] 把 `defaultObjectiveForStep()` 重构成 generic objective builder
- [ ] objective builder 不再按 `plan/build/...` 名字做核心逻辑分支
- [ ] `buildWorkOrder()` 接收 `AgentConfig`，使用 `description` 作为专长 hint
- [ ] 第一轮 objective 强调：
  - [ ] 理解用户任务
  - [ ] 识别当前重点
  - [ ] 尽量产出 actionable work items
- [ ] 后续轮 objective 强调：
  - [ ] 优先推进 open work items
  - [ ] 避免重复 resolved work
  - [ ] 明确记录 blockers / newly discovered work / resolved work

### 验收

- [ ] objective builder 不再依赖固定角色 taxonomy
- [ ] 任意用户自定义 agent 都能拿到合理 objective
- [ ] built-in `plan-build` 仍然能工作

---

## M3 - result parsing + merge

### 4. 扩展 structured result parsing

#### 任务

- [ ] 在 `src/workflow-result.ts` 解析 `newWorkItems`
- [ ] 解析 `resolvedWorkItems`
- [ ] 解析 `focusSummary`
- [ ] 对这些新字段做宽松校验
- [ ] 字段缺失时继续兼容原有 `v2` agent result

### 5. 扩展 merge 逻辑

#### 任务

- [ ] 在 `src/workflow-state.ts` 合并 `newWorkItems`
- [ ] 合并 `resolvedWorkItems`
- [ ] 更新 work-item `status / updatedAt`
- [ ] 当 blocker 与现有 work item 明显对应时，允许更新为 `blocked`
- [ ] 保留原有 `summary / decisions / artifacts / learnings / blockers / verification` merge 行为
- [ ] `focusSummary` 写入 shared state 的 focus 字段

### 6. 保持 repair retry 兼容

- [ ] 更新 structured response contract 示例
- [ ] 更新 repair prompt，让 repair 也支持 work-item 可选字段
- [ ] parse 失败时仍然只做一次 repair retry
- [ ] repair 失败仍然 fail fast

### 验收

- [ ] work-item 字段存在时会被成功 parse + merge
- [ ] work-item 字段缺失时 workflow 仍然正常运行
- [ ] repair retry 能覆盖扩展后的 contract

---

## M4 - projection + UI + persistence

### 7. 升级 projection / work order

#### 任务

- [ ] `buildWorkOrder()` 优先投影 open work items
- [ ] 投影 recent resolved work items
- [ ] 投影 current focus
- [ ] 保留原有 summary / decisions / artifacts / learnings / blockers / verification
- [ ] 对 work-item 列表做裁剪，避免 prompt 无限增长

### 8. 升级 UI 展示

#### 任务

- [ ] 在 workflow cards 顶部增加 open/done/blocked work-item count
- [ ] 在 step 展示里增加 current focus
- [ ] 在 step 展示里增加 top pending work-item 摘要
- [ ] 保持 `/workflow` 命令入口和 Zellij 行为不变

### 9. 升级调试落盘

#### 任务

- [ ] 在 `state.json` 保存 merged `workItems`
- [ ] 在 step result 文件里保存解析出的 work-item 更新
- [ ] 在 step result 文件里保存 `focusSummary`
- [ ] 保持现有 raw/repaired text 与 parsed result 落盘

### 验收

- [ ] 下一步收到的是更偏 action-oriented 的 projection
- [ ] UI 能体现 work-item progression
- [ ] 落盘文件能解释 work-item 是怎么变化的

---

## M5 - docs + manual validation

### 10. 更新文档

- [ ] 新增 `docs/planv3.md`
- [ ] 新增 `docs/taskv3.md`
- [ ] 如有必要，在 `README.md` 只补一小段 `v3 next` 说明
- [ ] 说明 `v3` 继续保持 workflow YAML 不变
- [ ] 说明 `v3` 不要求 agent 新 frontmatter
- [ ] 说明 work-item 字段是 soft contract
- [ ] 说明 `v3` 不做：
  - [ ] auto-skip
  - [ ] auto-reorder
  - [ ] dynamic step insertion
  - [ ] config/hooks/includes
  - [ ] teams / team-workflow

### 11. 手工验证矩阵

- [ ] `npm run typecheck`
- [ ] built-in `plan-build` 在没有 work-item 字段时仍可运行
- [ ] 单步用户自定义 workflow 在没有 work-item 字段时仍可运行
- [ ] 某个 review-like agent 产出 `newWorkItems` 后，下一步能收到这些事项
- [ ] 某个后续 step 产出 `resolvedWorkItems` 后，shared state 会把对应事项标记为 `done`
- [ ] unresolved work items 会持续出现在后续 objective / projection 中
- [ ] parse failure 仍会触发一次 repair retry
- [ ] blocked status 仍会停止 workflow
- [ ] Zellij 渲染路径不崩
- [ ] 非 Zellij 渲染路径不崩

### 验收

- [ ] 至少走通一组 built-in workflow
- [ ] 至少走通一组多步用户自定义 workflow
- [ ] 至少验证一组 `newWorkItems -> resolvedWorkItems` 链路
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

- [ ] `workflow-types`
- [ ] helper / selector

### PR 2 - Generic objective builder

- [ ] objective builder
- [ ] `buildWorkOrder` 更新

### PR 3 - Parse + merge

- [ ] result parsing
- [ ] work-item merge
- [ ] repair prompt 更新

### PR 4 - Projection + UI + persistence

- [ ] projection
- [ ] workflow cards / result rendering
- [ ] debug persistence

### PR 5 - Docs + manual validation

- [ ] docs
- [ ] manual validation matrix

---

## Done Definition

只有同时满足下面几条，才能算 `/workflow v3` 完成：

- [ ] workflow YAML 保持不变
- [ ] agent frontmatter 保持不变
- [ ] objective builder 已不再依赖硬编码角色
- [ ] shared state 已支持通用 work items
- [ ] structured result 已支持可选 work-item 更新
- [ ] projection 已优先体现 open work items
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
