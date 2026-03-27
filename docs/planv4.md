# /workflow v4 Plan

## 目标

`v4` 不再继续扩张 public config 面，而是收缩成两件事：

1. 给 runtime 增加最小 hook 管线。
2. 把 built-in agent 的固定 prompt 文案抽成 internal includes。

`v4` 建立在 `v3` 已经完成的 orchestrator intelligence 之上，不再试图引入新的用户配置层，也不改变 workflow/agent 的公开 authoring 方式。

换句话说：

- `v3` 解决的是 objective builder / work items / merge / projection
- `v4` 解决的是 hook extensibility + built-in prompt reuse

---

## 这次明确不做什么

`v4` 明确不做：

- 公开的 `.pi/conductor.json`
- 全局 `conductor.json`
- `defaultModel` 配置项
- 用户可定义的 `includes`
- workflow YAML 新 schema
- step-level user config
- teams
- team-workflow
- delegate runtime
- background execution model
- DAG
- resume
- auto-skip / auto-reorder / dynamic step insertion
- plugin runtime bridge

---

## 当前基线

当前 runtime 已经有这些能力：

- built-in / global / project agent 和 workflow 发现
- state-driven `WorkOrder`
- structured result parse / merge / repair retry
- step 级工具权限约束
- built-in `plan/build`
- workflow UI、落盘，以及 Zellij / 非 Zellij 两条渲染路径

所以 `v4` 不需要再发明新的 workflow 主循环，只需要在现有稳定接缝上扩展：

- workflow start
- step start
- step success
- step error
- built-in prompt composition

---

## v4 设计原则

### 1. 用户 authoring 方式保持不变

`v4` 不改变：

```yaml
plan-build:
  - plan
  - build
```

也不改变用户 agent 的基本模型：

- frontmatter 里继续只有 `name / description / tools / model`
- markdown body 继续是 agent 自己的完整 prompt body

### 2. 用户自定义 agent 继续拥有自己的 prompt

用户自定义 agent 仍然是“一个完整 prompt”，不是“只有 metadata，prompt 由插件拼出来”。

所以 `v4` 不会把用户 agent 改成：

- metadata only
- 插件自动推断角色
- 插件自动加某种 review / plan / fix 风格片段

### 3. 内置 include 只给 built-ins 用

`v4` 的 include 只是一层 internal prompt fragment 复用机制。

它的用途是：

- 把 built-in `plan/build` 里固定、可复用的 prompt 文案拆出来
- 减少硬编码重复
- 为后续继续扩 built-in agent 留一个稳定接缝

它**不是**：

- 用户可编辑 include 系统
- 用户 agent 的新 frontmatter 能力
- runtime 自动给所有 agent 加通用风格层

### 4. 不猜用户 agent 的语义角色

插件知道 built-in `plan/build` 的语义，所以可以安全地给它们挂 internal include。

但插件不知道用户新增 agent 的真实角色到底是什么，所以不能自动给用户 agent 附加类似：

- `plan-style`
- `review-style`
- `fix-style`

这样的角色型 prompt 片段。

### 5. runtime 动态注入仍然保留

下面这些内容继续由 runtime 动态注入，而不是抽成静态 include：

- 当前 step objective
- shared state projection
- structured response contract
- repair prompt

也就是说，include 只处理固定 prompt 文案复用，不接管 runtime 生成的动态上下文。

---

## 模型优先级

`v4` 明确固定 step 的模型解析顺序：

1. agent frontmatter 里的 `model`
2. 当前调用插件时所在 Pi session 的模型
3. Pi 自己的默认模型

这条规则的含义是：

- 如果用户给某个 agent 显式写了 `model`，用 agent 自己的
- 如果 agent 没写，就继承当前 Pi 会话的模型
- `v4` 不再设计一个额外的 config model fallback

---

## Hook 模型

`v4` 先只做最小 hook 面：

- `beforeWorkflow(state)`
- `beforeStep(workOrder, state)`
- `afterStep(result, state)`
- `onStepError(error, state)`

这些 hook 都是 internal-first runtime API，不通过用户配置文件暴露“任意代码路径注入”。

### hook 能做什么

- 在 workflow 开始前补充少量 metadata
- 在 step 开始前 augment `WorkOrder`
- 在 step 成功后 augment parsed result
- 在 step error 时补充 diagnostics / blocker 信息

### hook 不能做什么

- 不能接管 workflow 主循环
- 不能跳过 parser / merge
- 不能替换 orchestrator 对 state 的所有权
- 不能把 workflow 变成任意脚本执行框架

### hook 返回值形式

hook 应该返回 patch，而不是返回“替换后的完整对象”。

例如：

- `beforeWorkflow`
  - shared state patch
- `beforeStep`
  - work order patch
- `afterStep`
  - result patch
- `onStepError`
  - error / diagnostics patch

这样 runtime 仍然能稳定控制 merge 顺序和 failure 语义。

---

## Internal include 模型

`v4` 只需要一套插件内部 include registry。

推荐来源：

- `src/includes/*.md`

推荐用途：

- `workflow-role-common`
- `plan-style`
- `build-style`

最终 built-in agent prompt 的构成可以变成：

```text
base built-in prompt body
  + internal include fragments
```

但用户自定义 agent 不走这条路径，仍然直接使用它自己的 prompt body。

### prompt 顺序

对于 built-in agents：

1. built-in base fragments / internal includes
2. built-in agent 自己最终的角色提示

对于用户自定义 agents：

1. 用户写在 `.pi/agents/*.md` 里的 prompt body
2. runtime 动态注入的 objective / state / contract

不会存在“用户 prompt 和 internal include 争优先级”的问题，因为 internal include 不会自动应用到用户 agent。

---

## 文件边界建议

### 新增文件

- `src/workflow-hooks.ts`
  - hook 类型、patch merge、hook 调用辅助
- `src/workflow-prompt-composer.ts`
  - built-in prompt 组合逻辑
- `src/includes/`
  - internal include markdown 文件

### 重点修改文件

- `src/agents.ts`
  - 保持用户 agent frontmatter 不变
  - built-in agent 改成可通过 internal include 组合 prompt
- `src/workflow-runtime.ts`
  - 调用 hooks
  - 接入 built-in prompt composer
  - 保持现有模型 fallback 语义
- `src/workflow-prompts.ts`
  - 继续负责 structured step prompt / repair prompt
  - 不承担用户 include registry 逻辑
- `src/index.ts`
  - 保持从当前 Pi session 传默认模型给 workflow runtime

---

## 里程碑

### M1 - Hook pipeline

完成后应该能做到：

- runtime 在稳定接缝调用 hooks
- hook 只能 augment 数据
- hook error 有稳定 failure 语义

### M2 - Internal include registry + composer

完成后应该能做到：

- 插件内部能解析 built-in include 片段
- built-in prompt 可通过 composer 组合
- 用户 agent 路径完全不受影响

### M3 - Built-in prompt extraction

完成后应该能做到：

- built-in `plan/build` 的重复 prompt 文案被抽出
- built-in 行为不回退
- 用户 agent 不会自动吃 built-in role include

### M4 - Docs + manual validation

完成后应该能做到：

- 文档与实际设计一致
- 手工验证矩阵覆盖 hooks、built-in include、用户 agent 兼容性

---

## 手工验证重点

至少要覆盖这些场景：

- built-in `plan-build` 仍可运行
- built-in `plan/build` 在 include 抽取后行为不回退
- 用户自定义 agent prompt body 正常工作
- 用户自定义 agent 不会自动附加 built-in role include
- hook 触发顺序稳定
- hook error 有稳定 failure 语义
- repair retry 仍可运行
- blocked status 仍会停止 workflow
- Zellij / 非 Zellij 渲染路径不崩

---

## v4 Done Definition

只有同时满足下面几条，才能算 `/workflow v4` 完成：

- [ ] runtime 已支持最小 hook pipeline
- [ ] internal include registry 与 built-in prompt composer 已稳定
- [ ] built-in `plan/build` 已完成 prompt 抽取
- [ ] 用户公开 authoring 方式没有退化：
  - [ ] workflow YAML 仍然是 `string[]`
  - [ ] 用户 agent 仍然是 frontmatter + prompt body
- [ ] 用户自定义 agent 不会自动吃 built-in role include
- [ ] 模型优先级已保持：
  - [ ] `agent.model`
  - [ ] 当前 Pi session 模型
  - [ ] Pi 默认模型
- [ ] 文档与手工验证矩阵已补齐
