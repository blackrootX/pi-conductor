# /workflow v3 Plan

## 目标

`v3` 不是做一层更重的 extensibility framework，而是把当前的 orchestrator 从“能稳定串行执行 step”升级成“能更通用地推进任意用户自定义 workflow”。

`v3` 的核心目标有四条：

1. 保持 **现有 workflow YAML 形状** 不变。
2. 保持 **用户自定义 agent authoring 方式** 不变。
3. 不提前假设用户会写 `plan/build/review/fix` 这类固定角色。
4. 让 orchestrator 能基于 shared state 更智能地生成 objective、传递待办、收敛上下文。

这次升级只解决 orchestrator intelligence：

- generic objective builder
- richer shared state with work items
- expanded structured result contract
- smarter merge / projection

`v3` 不做 config、hooks、includes、teams、team-workflow、DAG、resume、自动选 agent、auto-skip。

---

## 当前现状（v2）

`v2` 已经解决了这些问题：

- workflow YAML 继续保持 `string[]`
- agent 继续保持普通 markdown frontmatter
- runtime 会统一注入 structured response contract
- step-to-step handoff 通过 `WorkflowState`
- parse 失败时会做一次 repair retry

但 `v2` 还有一个明显限制：

- objective builder 仍然偏静态
- shared state 只有 `summary / decisions / artifacts / learnings / blockers / verification`
- orchestrator 能传上下文，但还不太会传“下一步真正该处理的工作项”

所以 `v3` 的核心不是再加一层框架，而是让当前 state machine 更通用。

---

## v3 设计原则

### 1. orchestrator 负责推进机制，不负责业务语义

orchestrator 不应该预设：

- 哪些 agent 是 planner
- 哪些 agent 是 reviewer
- 哪些 agent 是 fixer

它只应该知道：

- 用户原始任务是什么
- 当前 shared state 是什么
- 当前 step 的 agent 名字和 description 是什么
- 当前有哪些未完成工作项
- 最近有哪些已完成工作

### 2. workflow 顺序继续由用户定义

`v3` 不改变：

```yaml
my-workflow:
  - agent-a
  - agent-b
  - agent-c
```

orchestrator 仍然严格按用户给定顺序执行。

`v3` 只改变：

- 每一步收到什么 objective
- 每一步收到什么 state projection
- 每一步结果怎么 merge 回 shared state

### 3. work items 是 soft contract，不是强制 authoring 规则

`v3` 会给 structured result 增加可选字段，帮助 agent 把“待办 / 已完成事项”结构化报回来。

但这些字段：

- 是可选的
- 不要求用户 agent 必须写
- 缺失时 runtime 仍然可以继续运行

### 4. 不做自动跳步

`v3` 只让 orchestrator 更会“分配和聚焦任务”，不让它篡改用户写好的 workflow 顺序。

所以：

- 不自动跳过 step
- 不自动插入 step
- 不自动重排 step

执行顺序仍然是用户定义的顺序。

---

## v3 目标态

### 用户视角

用户仍然可以：

- 写 `.pi/workflow.yaml`
- 写 `.pi/agents/*.md`
- 通过 `/workflow` 运行 workflow

用户不需要：

- 学新 workflow DSL
- 给 agent 加新 frontmatter
- 手工理解一套 role taxonomy

### 系统视角

运行模型从 `v2` 的：

```text
user task
  -> workflow state
  -> work order
  -> structured result
  -> merge
```

升级成：

```text
user task
  -> workflow state
  -> open work items / recent resolved work
  -> state-derived objective
  -> work order
  -> structured result with optional work-item updates
  -> merge / re-prioritize
  -> next step projection
```

也就是说，`v3` 让下一步拿到的不只是“已有上下文”，而是“当前最值得推进的工作”。

---

## 建议的数据模型

## 1) WorkItem

`v3` 新增一个最小通用工作项模型：

```ts
export interface WorkItem {
  id: string;
  title: string;
  details?: string;
  status: "open" | "in_progress" | "done" | "blocked";
  priority?: "low" | "medium" | "high";
  sourceStepId: string;
  sourceAgent: string;
  updatedAt: string;
}
```

这不是用户直接 authoring 的对象，而是 runtime 的内部统一工作项格式。

---

## 2) SharedState 扩展

在现有 `SharedState` 上增加：

```ts
export interface SharedState {
  summary?: string;
  decisions: DecisionItem[];
  artifacts: ArtifactItem[];
  learnings: string[];
  blockers: BlockerItem[];
  verification: VerificationItem[];
  workItems: WorkItem[];
}
```

约定：

- `open` / `in_progress` / `blocked` 都属于未完成工作
- `done` 属于已完成工作

---

## 3) AgentResult 扩展

在现有 structured result 上增加可选字段：

```ts
export interface AgentResult {
  status: "success" | "blocked" | "failed";
  summary: string;
  decisions?: DecisionItem[];
  artifacts?: ArtifactItem[];
  learnings?: string[];
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
  newWorkItems?: Array<{
    title: string;
    details?: string;
    priority?: "low" | "medium" | "high";
  }>;
  resolvedWorkItems?: Array<{
    title: string;
    resolution?: string;
  }>;
  focusSummary?: string;
  nextStepHint?: string;
  rawText?: string;
}
```

语义：

- `newWorkItems`
  - 当前 step 新发现的待处理事项
- `resolvedWorkItems`
  - 当前 step 认为已经解决的事项
- `focusSummary`
  - 当前 step 对“下一步应聚焦什么”的简要建议

这些字段全部是 optional。

---

## 4) WorkOrder 扩展

`v3` 的 `WorkOrder` 不再只传基础 shared state，还要带更明确的 task progression 信息：

```ts
export interface WorkOrder {
  stepId: string;
  agent: string;
  agentDescription?: string;
  objective: string;
  context: {
    userTask: string;
    summary?: string;
    decisions?: DecisionItem[];
    artifacts?: ArtifactItem[];
    learnings?: string[];
    blockers?: BlockerItem[];
    verification?: VerificationItem[];
    openWorkItems?: WorkItem[];
    recentResolvedWorkItems?: WorkItem[];
    currentFocus?: string;
  };
  constraints: string[];
  expectedOutput: WorkflowChannel[];
}
```

---

## objective builder 方案

`v3` 的关键改造点，是把当前偏静态的 objective builder 改成 state-driven builder。

### 目标

不再根据 agent 名字分支：

- `if plan -> ...`
- `if build -> ...`

改成根据下面四类信息生成 objective：

1. `userTask`
2. 当前未完成的 `workItems`
3. 最近已完成的 `workItems`
4. `agent.description`

### 默认生成规则

- 第一步：
  - 先理解用户任务
  - 建立当前工作重点
  - 如果能识别出 actionable work，就产出工作项
- 后续步骤：
  - 优先推进 `open / in_progress / blocked` 之外的未完成事项
  - 参考当前 agent description，把任务描述成“按你的专长推进 workflow”
  - 避免重复已完成工作
  - 明确要求说明新增事项、已解决事项和阻塞事项

### built-in agent 的位置

built-in `plan` / `build` 的 system prompt 可以继续保留，但 objective generation 不再依赖 agent name branch。

---

## merge 规则

`v3` 在现有 merge 规则上，增加对 work items 的统一处理。

### 标题归一化

work item 匹配使用 runtime 归一化标题，例如：

- trim
- lower-case
- collapse whitespace

runtime 负责生成真正的 `id`。

### `newWorkItems`

- 按归一化标题 upsert
- 如果不存在，新增为 `open`
- 如果已存在且不是 `done`，更新 details / priority / updatedAt
- 如果已存在且是 `done`，保持 `done`，只更新时间和补充信息

### `resolvedWorkItems`

- 按归一化标题匹配
- 如果匹配到，更新为 `done`
- 如果没匹配到，仍然补一个 `done` item，避免历史信息丢失

### blockers

- `blockers` 继续保留在原 channel
- 如果 blocker 与现有 work item 明显对应，可以把该 item 状态更新成 `blocked`
- 如果没有明显对应项，不强行创建 work item

### focus

- `focusSummary` 只更新 shared state 里的当前 focus 提示
- 不替代全局 summary

---

## projection 规则

下一步的 prompt projection 要比 `v2` 更偏“当前行动”。

默认顺序：

1. `userTask`
2. `currentFocus`
3. 高优先级 open work items
4. 近期 resolved work items
5. summary
6. decisions / artifacts / learnings / blockers / verification

### 裁剪原则

- open items 优先展示
- resolved items 只展示最近少量
- 历史 lists 继续限量
- 不把 transcript 当作主要 handoff

---

## prompt contract 变化

`v3` 的 structured response contract 需要更新，但仍保持低表面复杂度。

runtime prompt 需要明确：

- `newWorkItems / resolvedWorkItems / focusSummary` 是可选增强
- 如果当前 step 发现新的待处理事项，尽量用 `newWorkItems`
- 如果当前 step 解决了已有事项，尽量用 `resolvedWorkItems`
- 如果没有 work-item 级结论，可以只返回原有字段

repair prompt 也要同步支持这些可选字段。

---

## UI / 调试变化

`v3` 的 UI 不需要大改形态，但要体现 work-item progression。

建议展示：

- open / done / blocked work-item count
- 当前 step objective
- 当前 focus summary
- 最近新增或最近解决的工作项摘要

落盘也应增加：

- merged work items
- step 解析出的 `newWorkItems / resolvedWorkItems / focusSummary`

---

## Not in v3

`v3` 明确不做：

- config loader
- hooks
- includes / skills
- teams
- team-workflow
- parallel step
- DAG
- resume
- 自动选 agent
- auto-skip / auto-reorder / dynamic step insertion

这些能力可以留给 `v4+`。

---

## 成功标准

只有同时满足下面几条，才能算 `v3` 完成：

- 用户不需要改 workflow YAML
- 用户不需要补新 frontmatter
- orchestrator 已不再依赖硬编码角色来生成 objective
- shared state 已能追踪 open/done/blocked work items
- 结果 contract 已支持可选 work-item 更新
- 下一步收到的是更聚焦的 action-oriented projection
- 无 work-item 字段的老 agent 仍可继续跑
- repair retry 与 blocked 路径仍保持可用

---

## 假设

- `v3` 继续遵守仓库约束，不新增测试文件。
- `v3` 是 orchestrator intelligence 升级，不是 extensibility 基础设施版本。
- 用户 workflow 顺序永远优先于 runtime 智能判断。
- soft-contract work-item 字段只是增强，不是新 authoring 要求。
