# /workflow v2 Tasks

> 目标：在保持用户自定义 agent 与现有 workflow YAML 写法不变的前提下，为 `pi-conductor` 的 `/workflow` 引入 orchestrator layer、runtime-enforced structured handoff、一次 repair retry 和更清晰的状态展示。

`v2` 不包含 config、hooks、skills/includes、teams、team-workflow。

---

## 里程碑总览

- M1：类型 + internal workflow normalization
- M2：runtime guidance contract + prompt wrapping
- M3：orchestrator runtime + parse / repair / validation
- M4：UI + debug persistence
- M5：docs + manual validation

---

## M1 - 类型与 internal workflow normalization

### 1. 新建或整理核心类型

- [x] 新建 `src/workflow-types.ts`，或先临时放在 `workflow-runtime.ts`
- [x] 定义 `WorkflowChannel`
- [x] 定义 internal `WorkflowStepConfig`
- [x] 定义 internal `WorkflowConfig`
- [x] 定义 `DecisionItem / ArtifactItem / BlockerItem / VerificationItem`
- [x] 定义 `SharedState`
- [x] 定义 `StepRunState`
- [x] 定义 `WorkflowState`
- [x] 定义 `WorkOrder`
- [x] 定义 `AgentResult`

### 验收

- [x] 所有 workflow/runtime 新逻辑都引用统一类型，不再散落在各文件里
- [x] `npm run typecheck` 通过

---

### 2. 升级 `src/workflows.ts`

#### 当前问题

- 只支持 `workflowName -> string[]`
- runtime 仍然直接依赖 `agentNames`

#### 任务

- [x] 保留现有 built-in workflow 默认值
- [x] 保持用户 YAML 继续写 `string[]`
- [x] 把 `string[]` normalize 成 internal `steps[]`
- [x] 给每个 step 生成稳定 `id`
- [x] 保持 source/filePath 逻辑不变
- [x] 保持 project > global > built-in 覆盖优先级不变
- [x] 提供 `normalizeWorkflowConfig()` 给 runtime 使用统一结构

### 验收

- [x] 旧 YAML 可以直接运行
- [x] runtime 不再依赖 `agentNames`
- [x] 引用不存在的 agent 仍在执行前失败

---

## M2 - runtime guidance contract + prompt wrapping

### 3. 保持 `src/agents.ts` 轻量

#### 当前问题

- agent discovery 目前只能读出基础 frontmatter
- 但 `v2` 不希望强制用户新增 metadata

#### 任务

- [x] 保持现有 `name / description / tools / model` 解析不变
- [x] 不要求用户新增 `handoff_mode`、`consumes`、`produces`
- [x] 如需新增字段，只允许作为内部可选 hint，不作为前提条件

### 验收

- [x] 老 `.pi/agents/*.md` 不需要改也能继续跑 workflow

---

### 4. 统一 runtime contract

#### 任务

- [x] 新增 `buildWorkOrder(state, step, agent)`
- [x] 新增 `renderStructuredStepPrompt(workOrder)`
- [x] 统一把每个 workflow step 包成 runtime contract
- [x] prompt 必须明确：
  - [x] 这是 workflow step，不是直接和下一个 agent 对话
  - [x] 必须返回 marker block JSON
  - [x] 必须至少包含 `status` 和 `summary`
  - [x] 可选补充 `decisions / artifacts / learnings / blockers / verification`
- [x] built-in `plan` / `build` 的系统提示文案顺手优化，使其更容易遵守新 contract

### 验收

- [x] 任意 workflow step 都会收到统一的 structured response contract
- [x] built-in `plan-build` 在 prompt 层面已与 `v2` 模型对齐

---

## M3 - orchestrator runtime + parse / repair / validation

### 5. 重构 `src/workflow-runtime.ts`

#### 当前问题

- 当前 handoff 是 `currentInput = getFinalOutput(result.messages)`
- orchestrator 没有 workflow state
- structured output 没有 parse / repair / validation

#### 任务 A：状态初始化

- [x] 新增 `createInitialSharedState()`
- [x] 新增 `createWorkflowState(workflow, task)`
- [x] 初始化 `steps[]`
- [x] 初始化 `status/currentStepIndex`

#### 任务 B：结果提取

- [x] 新增 `extractStructuredBlock(text)`
- [x] 新增 `parseAgentResult(text)`
- [x] 新增 `validateAgentResultShape(result)`
- [x] 允许 marker block 外还有自由文本

#### 任务 C：repair retry

- [x] 新增 `renderRepairPrompt(rawText, parseError)`
- [x] parse 失败时对同一步做一次 repair retry
- [x] repair 成功则继续 merge
- [x] repair 失败则当前 step fail fast

#### 任务 D：merge + projection

- [x] 新增 `mergeAgentResultIntoState(state, step, result)`
- [x] `decisions` 去重
- [x] `artifacts` 去重
- [x] `learnings` 去重
- [x] `verification` 追加
- [x] `blockers` 追加
- [x] 更新 step status / rawFinalText / repairedFinalText / parseError / timestamps

#### 任务 E：workflow stop 与 final output

- [x] 明确 `failed` 的 stop 路径
- [x] 明确 `blocked` 的 stop 路径
- [x] 明确 validation error 的 stop 路径
- [x] 最终输出由 state 聚合生成
- [x] 不再把最后一个 assistant text 当成最终 handoff

#### 任务 F：主循环替换

- [x] 用 `WorkflowState` 替换 `currentInput: string`
- [x] 每一步先 `buildWorkOrder`
- [x] 再 `render prompt`
- [x] 再 `runSingleAgent`
- [x] 再 `parse`
- [x] parse 失败则 `repair`
- [x] repair / parse 成功后再 `validate + merge`

### 验收

- [x] runtime 不再依赖“上一 step 文本 = 下一 step 输入”
- [x] 所有 step handoff 都来自 state projection
- [x] parse 失败时会自动做一次 repair retry
- [x] repair 失败会明确停止 workflow

---

## M4 - UI + debug persistence

### 6. 升级 `src/index.ts`

#### 任务

- [x] 保持 `conductor` 工具名不变
- [x] 保持 `/workflow` 命令入口不变
- [x] 更新 `WorkflowDetails` 的展示内容，能携带更多状态信息
- [x] 最终返回文本不再只依赖最后一个 step 的 assistant text
- [x] 失败时提示 step + parse / repair / validation / agent 错误原因
- [x] Zellij 路径继续兼容

### 验收

- [x] 用户仍然只需使用 `/workflow`
- [x] 非 Zellij / Zellij 两条路径都能显示升级后的状态

---

### 7. 升级 `src/workflow-cards.ts`

#### 当前问题

- 只显示 `status / elapsed / lastWork`

#### 任务

- [x] 顶部增加 workflow state 摘要：
  - [x] decisions count
  - [x] learnings count
  - [x] blockers count
  - [x] verification count
- [x] 卡片里增加 current objective
- [x] 对 `lastWork` 继续保留，但弱化为“最近摘要”
- [x] repair retry 发生时给调试视图可见反馈

### 验收

- [x] 用户能看出这是 orchestrated workflow，而不只是文本链
- [x] repair 过程在调试视图里可追踪

---

### 8. 新增 workflow run state 落盘

#### 任务

- [x] 选定目录：`.pi/workflow-runs/{runId}/`
- [x] 落 `state.json`
- [x] 落 `steps/NN-agent.result.json`
- [x] 保存原始 final text
- [x] 保存 repaired final text（如果发生）
- [x] 保存 parsed `AgentResult`
- [x] 保存简短 metadata（workflowName/source/start/end/status）

### 验收

- [x] workflow 失败时可以从落盘文件快速定位是 parse、repair、validation 还是 merge 出问题

---

## M5 - docs + manual validation

### 9. 更新文档

#### 任务

- [x] 更新 `README.md`
- [x] 更新 `docs/workflow-plan.md`
- [x] 说明 `v2` 的内部 orchestrator 模型
- [x] 说明 workflow YAML 形状保持不变
- [x] 说明用户 agent 不需要强制补新 frontmatter
- [x] 说明 runtime-enforced response contract
- [x] 说明 repair retry 行为
- [x] 说明当前仍不支持的特性：
  - [x] 并行 step
  - [x] DAG
  - [x] resume
  - [x] 自动选 agent
  - [x] teams / team-workflow

### 验收

- [x] 新用户看 README 能理解 `v2` 模型
- [x] 老用户看文档能知道原来的 workflow 和 agent 写法仍然成立

---

### 10. 手工验证矩阵

- [x] `npm run typecheck`
- [x] 旧 workflow YAML 可运行
- [x] 旧用户自定义 agent 不改 frontmatter 也可运行
- [x] 正常 structured response 路径可运行
- [x] 非法 structured response 可触发一次 repair retry
- [x] repair 后成功的路径可运行
- [x] repair 后仍失败的路径会明确报错
- [x] `status: blocked` 会终止 workflow 并显示 blocker 摘要
- [x] Zellij progress file 更新不崩
- [x] 非 Zellij 当前会话渲染不崩

### 验收

- [x] 至少手工走通一组 built-in workflow
- [x] 至少手工走通一组用户自定义 agent workflow
- [x] 至少手工验证一组 repair retry 场景

### 已执行验证

- [x] 使用真实 `pi` + `minimax-cn/MiniMax-M2.7` 跑通 built-in `plan-build`
- [x] 使用真实 `pi` + 无新增 frontmatter 的自定义 agent 跑通单步 workflow
- [x] 使用可控 fake `pi` 验证 repair success / repair fail / blocked / 落盘
- [x] 使用 `scripts/workflow-pane.mjs` 验证 progress/status 文件更新
- [x] 通过注册扩展并调用 `conductor.renderResult()` 验证非 Zellij 渲染路径可构造

---

## Future automation coverage

受仓库策略限制，当前不新增测试文件。

如果后续策略允许，再补自动化覆盖：

- workflow normalization
- structured result parsing
- repair retry
- state merge / projection

---

## 推荐 PR 切分

### PR 1 - Types + workflow normalization

- [x] `workflow-types`
- [x] `workflows.ts` internal `steps[]`

### PR 2 - Prompt wrapping + runtime contract

- [x] `buildWorkOrder`
- [x] `renderStructuredStepPrompt`
- [x] built-in prompt polish

### PR 3 - Runtime orchestrator core

- [x] `WorkflowState`
- [x] parse / validate
- [x] repair retry
- [x] merge / projection
- [x] 主循环替换

### PR 4 - UI + persistence

- [x] `index.ts`
- [x] `workflow-cards.ts`
- [x] 落盘 debug state

### PR 5 - Docs + manual validation

- [x] README
- [x] workflow-plan
- [x] 手工验证矩阵

---

## Done Definition

只有同时满足下面几条，才能算 `/workflow v2` 完成：

- [x] 旧 workflow YAML 不破
- [x] 用户自定义 agent 不需要补新 frontmatter
- [x] orchestrator 已拥有 shared workflow state
- [x] structured handoff 已替代直接 dump 上下文
- [x] runtime 已统一注入 structured response contract
- [x] parse 失败会自动做一次 repair retry
- [x] repair 失败会明确中止 workflow
- [x] UI 能体现 decisions/learnings/verification/blockers 的推进
- [x] 文档和手工验证都补齐

---

## 最后的执行顺序建议

按下面顺序做，阻力最小：

1. `src/workflow-types.ts`
2. `src/workflows.ts`
3. `src/workflow-runtime.ts`
4. `src/index.ts`
5. `src/workflow-cards.ts`
6. 文档
7. 手工验证

这样你能最早看到 runtime 升级成型，而不会一开始就被 UI 和边角行为拖住。
