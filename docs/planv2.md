# /workflow v2 Plan

## 目标

把现在的 `/workflow` 从 **顺序文本接力** 升级成 **orchestrator 持有状态、runtime 统一要求结构化交付、下一步拿到的是状态投影而不是上一步原文** 的工作流系统。

`v2` 的核心目标有三条：

1. 保持 **用户自定义 agent** 这个产品核心不变。
2. 保持 **现有 workflow YAML 形状** 不变。
3. 把 structured handoff 变成 **插件内部协议**，而不是要求用户学习的新框架。

这次升级只解决 workflow core：

- internal workflow normalization
- orchestrator-owned state
- runtime-enforced structured handoff
- UI / debug persistence

---

## 当前现状（v1）

### 产品行为

- `/workflow` 是公开命令，`conductor` 是内部工具。
- workflow 来源仍然是：项目 `.pi/workflow.yaml`、全局 `~/.pi/agent/workflow.yaml`、内置默认值。
- 用户当前写的是最简单的顺序列表：

```yaml
plan-build:
  - plan
  - build
```

- 执行模型是严格顺序执行：
  - 第一个 step 收到用户原始任务。
  - 后续 step 只收到上一个 step 的最终文本输出。

### 代码现实

- `src/workflows.ts` 目前只解析 `string[]` 形式的 workflow。
- `src/agents.ts` 目前只支持很轻的 frontmatter：`name / description / tools / model`。
- `src/workflow-runtime.ts` 的核心 handoff 逻辑本质上是：
  - 运行 agent
  - 抽最后的 assistant text
  - `currentInput = getFinalOutput(result.messages)`
- `src/index.ts` 负责注册 `/workflow` 和 `conductor`，并复用当前 workflow 卡片/UI 展示。
- `src/workflow-cards.ts` 目前只展示 step 级别的状态、耗时和 `lastWork`。

---

## v2 设计原则

### 1. workflow YAML 继续保持简单

`v2` 不引入新的 workflow DSL。

用户继续写：

```yaml
my-workflow:
  - agent-a
  - agent-b
  - agent-c
```

插件内部再把它 normalize 成统一的 `steps[]` 结构供 runtime 使用。

### 2. 用户 agent 不需要先改写成 structured agent

用户现有的 agent markdown 继续可以被 workflow 调用。

插件 runtime 会统一给每个 step 包一层强约束 prompt，告诉 agent：

- 你现在是在 workflow step 里运行
- 你是在向 orchestrator 汇报，不是在直接对下一个 agent 说话
- 你必须返回结构化结果

也就是说，structured handoff 是 **runtime 协议**，不是用户必须手工迁移的 authoring 模式。

### 3. subagent 不直接互相通信

统一改成：

```text
Agent A -> Orchestrator State -> Agent B
```

所有跨 step 信息都进入 orchestrator 维护的 `WorkflowState`，再由 orchestrator 按下一步需要进行投影。

### 4. 低表面复杂度，高内部约束

这个插件的价值不是定义一套很重的新框架，而是：

- 外部继续自由
- 内部强制协议
- 出错时校验、修复、明确失败

`v2` 不要求用户学习 mode、handoff_mode、team、category、delegate 之类的新概念。

### 5. structured parse 失败允许一次修复重试

对于任意写法的用户 agent，只靠一次 prompt wrapper 不能保证 100% 稳定。

因此 `v2` 默认策略是：

- 首次输出 parse
- parse 失败后做一次 repair retry
- 再失败则当前 step fail fast

---

## Not in v2

以下能力明确不放进 `v2`：

- conductor config
- hooks
- skills / includes
- teams
- team-workflow
- DAG
- resume
- 自动选 agent
- delegate / category / task runtime
- 新的 workflow YAML schema
- 强制用户补 agent metadata

这些会留到 `v3` 及以后处理。

---

## v2 目标态

### 用户视角

用户仍然可以：

- 通过 `.pi/workflow.yaml` 定义 workflow
- 通过 `.pi/agents/*.md` 自定义 agent
- 通过 `/workflow` 运行 workflow

用户不需要：

- 改 workflow YAML 结构
- 把 agent 全部改写成新 DSL
- 理解 mixed-mode handoff

### 系统视角

运行模型从：

```text
user task -> agent1 text -> agent2 text -> agent3 text
```

升级成：

```text
user task
  -> orchestrator state
  -> normalized step list
  -> work order for step 1
  -> structured result 1
  -> merged state
  -> work order for step 2
  -> structured result 2
  -> merged state
  -> ...
```

下一步永远吃 `WorkflowState` 的 projection，而不是上一 step 的原文全文。

---

## 建议的数据模型

## 1) Internal WorkflowConfig

用户 YAML 不变，但 runtime 内部统一转换成下面的结构：

```ts
export interface WorkflowStepConfig {
  id: string;
  agent: string;
}

export interface WorkflowConfig {
  name: string;
  steps: WorkflowStepConfig[];
  source: WorkflowSource;
  filePath?: string;
}
```

这里的 `steps[]` 是 internal normalized shape，不要求用户直接写这个格式。

---

## 2) WorkflowState

```ts
export type WorkflowChannel =
  | "summary"
  | "decisions"
  | "artifacts"
  | "learnings"
  | "blockers"
  | "verification";

export interface DecisionItem {
  topic: string;
  decision: string;
  rationale?: string;
}

export interface ArtifactItem {
  kind: string;
  path?: string;
  text?: string;
}

export interface BlockerItem {
  issue: string;
  needs?: string;
}

export interface VerificationItem {
  check: string;
  status: "pass" | "fail" | "not_run";
  notes?: string;
}

export interface SharedState {
  summary?: string;
  decisions: DecisionItem[];
  artifacts: ArtifactItem[];
  learnings: string[];
  blockers: BlockerItem[];
  verification: VerificationItem[];
}

export interface StepRunState {
  stepId: string;
  agent: string;
  objective: string;
  status: "pending" | "running" | "done" | "blocked" | "failed";
  startedAt?: string;
  finishedAt?: string;
  result?: AgentResult;
  rawFinalText?: string;
  repairedFinalText?: string;
  parseError?: string;
}

export interface WorkflowState {
  runId: string;
  workflowName: string;
  userTask: string;
  status: "pending" | "running" | "done" | "blocked" | "failed";
  currentStepIndex: number;
  shared: SharedState;
  steps: StepRunState[];
}
```

---

## 3) WorkOrder

每次 orchestrator 发给子 agent 的不是散乱文本，而是一份统一工作指令。

```ts
export interface WorkOrder {
  stepId: string;
  agent: string;
  objective: string;
  context: {
    userTask: string;
    summary?: string;
    decisions?: DecisionItem[];
    artifacts?: ArtifactItem[];
    learnings?: string[];
    blockers?: BlockerItem[];
    verification?: VerificationItem[];
  };
  constraints: string[];
  expectedOutput: WorkflowChannel[];
}
```

`v2` 里 `consumes / produces` 先不暴露成用户配置；默认所有 step 都看到一份裁剪后的 shared state projection。

---

## 4) AgentResult

```ts
export interface AgentResult {
  status: "success" | "blocked" | "failed";
  summary: string;
  decisions?: DecisionItem[];
  artifacts?: ArtifactItem[];
  learnings?: string[];
  blockers?: BlockerItem[];
  verification?: VerificationItem[];
  nextStepHint?: string;
  rawText?: string;
}
```

---

## runtime-enforced structured 输出协议

第一版不要求 agent 输出“全文纯 JSON”，太脆。

建议统一要求返回下面这种 marker block：

````text
[WORKFLOW_RESULT_BEGIN]
{
  "status": "success",
  "summary": "Implemented auth middleware and added route guards.",
  "artifacts": [
    { "kind": "file", "path": "src/auth.ts" }
  ],
  "learnings": [
    "The repo already has a shared error helper in src/lib/errors.ts"
  ],
  "verification": [
    { "check": "npm run typecheck", "status": "pass" }
  ]
}
[WORKFLOW_RESULT_END]

Human summary:
- implemented auth middleware
- updated route registration
````

### 为什么用 marker block

优点：

- agent 仍然能自然写解释
- machine-readable 部分容易抽取
- runtime 可以在 parse 失败时做 repair retry

### 解析规则

- marker block 是首选协议，不要求全文纯 JSON。
- 允许 marker block 外还有自由文本。
- parse 失败后做一次 repair retry。
- repair 失败则当前 step 直接失败，不再 fallback 到 legacy text handoff。
- `status: blocked` 视为 workflow stop 条件，并在最终错误里带 blocker 摘要。

---

## Uniform Handoff Contract

`v2` 不保留 mixed-mode。

这不意味着用户必须手改自己的 agent，而是意味着：

- 所有 workflow step 在 runtime 看来都必须产出 structured result
- 所有 step-to-step handoff 都通过 `WorkflowState`
- 不再允许“上一 step 文本原样传给下一 step”作为正式协议

### 实际语义

- 用户 agent 可以继续是原来的写法
- 但 runtime 会统一包装 prompt，要求它提交 `AgentResult`
- 下一步永远只看到 shared state projection

---

## merge / projection 规则

## merge 规则

orchestrator 收到 `AgentResult` 之后，按固定规则归并到 `WorkflowState.shared`。

### 建议实现

- `summary`
  - 用本 step 的 `summary` 更新 shared summary
  - 另外保留 step 级 raw summary，供 UI 和调试使用
- `decisions`
  - 追加并按 `topic + decision` 做去重
- `artifacts`
  - 追加并按 `kind + path + text` 做去重
- `learnings`
  - 追加并做字符串去重
- `blockers`
  - 追加；先不做复杂的 resolved 机制
- `verification`
  - 追加；保留历史，不覆盖

## projection 规则

下一步 step 不应该看到全部 transcript，而是看到一份统一裁剪后的 shared state 投影。

默认投影包括：

- `summary`
- `decisions`
- `artifacts`
- `learnings`
- `blockers`
- `verification`

如果后续发现 context 太大，再在 `v3` 用 config / includes / hooks 去细化。

---

## Workflow YAML 方案

`v2` 不升级用户的 workflow YAML 形状。

## 继续支持的格式

```yaml
plan-build:
  - plan
  - build
```

### runtime 内部行为

- 解析 YAML
- 把数组 workflow normalize 成 `steps[]`
- 在 internal model 里运行 orchestrator loop

所以：

- 用户看到的 workflow authoring 方式不变
- runtime 内部已经不是 `agentNames + currentInput`

---

## Agent 方案

`v2` 不要求用户修改自己的 agent frontmatter。

现有 agent 继续可以长这样：

```md
---
name: build
description: Implementation specialist
tools: read,write,edit,grep,find,ls,bash
model: anthropic/claude-sonnet-4.6
---

You are the build step in a coding workflow.
Execute the assigned implementation task.
```

### runtime 怎么接管

runtime 负责在每次调用时额外注入：

- 当前 step 的 objective
- 当前 workflow 的 shared state
- 必须遵守的 response contract
- parse 失败后的 repair contract

这层 runtime prompt 才是 structured handoff 的真正入口。

---

## runtime 改造方案

## 1) 规范化 workflow

在 `src/workflows.ts` 中：

- 继续解析当前 YAML
- 输出统一的 internal `WorkflowConfig { steps }`
- 保持 source/filePath 逻辑不变
- 保持 project > global > built-in 覆盖优先级不变

## 2) 保持 agent discovery 轻量

在 `src/agents.ts` 中：

- 继续解析现有 frontmatter
- 不强制新增 metadata
- built-in `plan` / `build` 只做 prompt 文案优化

## 3) 重写 workflow 主循环

在 `src/workflow-runtime.ts` 中：

当前主循环实际上是：

```ts
let currentInput = task;
for (...) {
  const result = await runSingleAgent(..., currentInput, ...)
  currentInput = getFinalOutput(result.messages)
}
```

`v2` 要改成：

```ts
const state = createWorkflowState(...)
for (...) {
  const workOrder = buildWorkOrder(state, step)
  const prompt = renderStructuredStepPrompt(workOrder)
  const rawResult = await runSingleAgent(..., prompt, ...)
  const parsed = parseAgentResult(rawResult)

  if (!parsed.ok) {
    const repairedRawResult = await repairAgentResult(...)
    const repaired = parseAgentResult(repairedRawResult)
    if (!repaired.ok) fail step
  }

  mergeAgentResult(state, step, normalizedResult)
}
```

### 关键点

- `runSingleAgent()` 仍然可以复用
- 变化主要发生在输入构造、输出解析、repair retry 和 state merge 上
- `currentInput` 这个单字符串 handoff 概念，会被 `WorkflowState + WorkOrder` 替代

---

## prompt 组装规则

建议所有 workflow step 的 prompt 都由 runtime 统一组装。

## 模板结构

1. `TASK`
2. `STEP OBJECTIVE`
3. `CURRENT CONTEXT`
4. `MUST DO`
5. `MUST NOT DO`
6. `RESPONSE CONTRACT`

### 例子

```text
TASK
Implement auth in this repository.

STEP OBJECTIVE
Produce the next workflow result for the assigned step.

CURRENT CONTEXT
Summary:
...

Decisions:
- Use middleware-based auth

Learnings:
- Existing HTTP helpers live in src/http/

MUST DO
- Inspect the repository before editing.
- Make concrete changes if the task requires it.
- Report verification results when applicable.

MUST NOT DO
- Do not talk to the next agent directly.
- Do not rely on free-form prose alone.
- Do not omit the required result block.

RESPONSE CONTRACT
Return one JSON object between [WORKFLOW_RESULT_BEGIN] and [WORKFLOW_RESULT_END].
```

---

## final output 规则

`v2` 的最终输出不再等同于“最后一个 assistant text”。

最终返回文本由 workflow state 聚合生成：

- 优先使用 shared `summary`
- 如果存在 `blockers`，追加 blocker 摘要
- 如果存在 `verification`，追加 verification 摘要
- 如果 workflow 因 `blocked` 或 `failed` 停止，错误文本要带 step 信息和结构化原因

---

## UI 升级方向

当前 `workflow-cards` 只显示：

- status
- elapsed
- lastWork

`v2` 建议增加：

- current objective
- shared state 摘要计数：
  - `decisions`
  - `learnings`
  - `blockers`
  - `verification`
- parse / repair 状态提示

### UI 最小升级

- 保持现在的卡片布局
- 在 workflow 顶部多显示一段状态摘要
- 当前 step 卡片里显示更明确的 objective
- 如果发生 repair retry，让调试视图能看出来

---

## 落盘与调试

第一版建议把 workflow run state 落盘，便于 debug 和后续 resume 扩展。

## 目录建议

```text
.pi/workflow-runs/{runId}/
  state.json
  steps/
    01-plan.result.json
    02-build.result.json
```

### v2 中的用途

- 调试 structured result
- 调试 repair retry
- 回放某个 workflow run
- 支持失败时快速定位 parse / validation / merge 问题

### 暂不做

- 从任意 step 恢复运行
- 人工编辑 state 后继续

---

## 成功标准

## 功能标准

- 旧的 workflow YAML 仍然可以正常跑。
- 用户自定义 agent 不需要补新 frontmatter 就可以参与 workflow。
- runtime 已拥有 shared workflow state。
- 下一步输入不再是上一 step 原文，而是 orchestrator 投影的 context。
- built-in `plan -> build` 可以通过 structured handoff 传递 decisions / learnings / artifacts / verification。
- parse 失败时会自动做一次 repair retry。

## 体验标准

- 用户继续用 `/workflow`，不需要学习另一套命令。
- 用户定义 workflow 的方式不变。
- 用户定义 agent 的方式不变。
- UI 能明显体现 workflow state 的推进，而不只是 transcript 摘要。

## 工程标准

- 类型定义清晰
- 解析失败有一次 repair retry
- repair 失败会明确报错
- 不破坏现有 Zellij 模式
- 对失败 step 能给出明确错误位置和错误原因

---

## 风险与缓解

## 风险 1：用户 agent 不稳定输出 structured block

缓解：

- runtime 强制注入 response contract
- parse 失败做一次 repair retry
- repair 后仍失败则明确中止，不做隐式降级

## 风险 2：context 反而变大

缓解：

- 统一走 state projection，而不是传全部 transcript
- 对 artifacts / verification 做摘要

## 风险 3：框架感太强

缓解：

- 不改 workflow YAML 形状
- 不强制 agent metadata 迁移
- structured contract 只在 runtime 内部体现

## 风险 4：runtime 逻辑变复杂

缓解：

- 先做 runtime orchestrator，不做 LLM orchestrator
- 尽量把解析、repair、merge、prompt 组装拆成独立函数

---

## 一句话结论

`/workflow v2` 的核心不是让用户学习一套新的 workflow 框架，而是：

> **保持用户的 agent 和 workflow 写法基本不变，在插件内部把任意 step 统一拉进 structured handoff 协议。**

`v3` 会借鉴 oh-my-openagent 的 runtime extensibility 思路，但不会引入它的插件 runtime。
