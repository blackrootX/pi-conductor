# /workflow v4 Plan

## 目标

`v4` 把 `/workflow` 收缩成两个内部能力：

1. 最小可控的 runtime hook 管线
2. 只服务 built-in agent 的 internal prompt includes

这次不再扩 public config 面，也不改变用户写 workflow 和 agent 的公开方式。

换句话说：

- `v3` 解决的是 orchestrator intelligence
- `v4` 解决的是 hook extensibility + built-in prompt reuse

---

## 明确不做

`v4` 不做下面这些东西：

- 公开的 `.pi/conductor.json`
- 全局 `conductor.json`
- 用户可编辑 `includes`
- workflow YAML 新 schema
- step-level user config
- teams / team-workflow
- delegate runtime
- background execution model
- DAG / resume
- auto-skip / auto-reorder / dynamic step insertion
- plugin runtime bridge

---

## 用户模型保持不变

`v4` 不改变 workflow authoring：

```yaml
plan-build:
  - plan
  - build
```

`v4` 也不改变用户 agent authoring：

- frontmatter 继续只有 `name / description / tools / model`
- markdown body 继续是用户 agent 的完整 prompt
- runtime 不自动给用户 agent 附加角色型 include

所以用户自定义 agent 仍然是“完整 prompt”，不是 metadata-only 定义。

---

## Hook 模型

`v4` 增加四个 internal-first hook：

- `beforeWorkflow`
- `beforeStep`
- `afterStep`
- `onStepError`

它们都只返回 patch，不返回完整替换对象。

### patch 语义

- `beforeWorkflow`
  - 只 patch shared state
- `beforeStep`
  - patch `WorkOrder`
- `afterStep`
  - patch已经 parse 成功的 `AgentResult`
- `onStepError`
  - patch error diagnostics，以及少量 shared blocker / verification 信息

runtime 仍然保留对 parser、merge 顺序、fail-fast 语义和 workflow 主循环的最终所有权。

### hook 输入约束

- hook 收到的是 immutable snapshot，不是 live runtime object
- hook 可以观察当前 state / workOrder / result
- hook 不能通过原地 mutation 绕过 patch merge 语义
- 真正生效的变更仍然只能通过 hook 返回 patch

### merge 原则

- 标量字段按 patch 覆盖
- 列表字段按 key 去重追加
- `afterStep.status` 只能升级严重度，不会把失败降级成成功
- hook 不能绕过 parser / merge / repair retry

### hook error 处理

- `beforeWorkflow` 抛错
  - workflow 启动失败
- `beforeStep` / `afterStep` 抛错
  - 归一化成当前 step failure
- `onStepError` 自己抛错
  - 不覆盖原始错误，只追加 diagnostics

### hook 可达性

`v4` 现在不仅在 runtime 层支持 hook，也在 extension 入口把 hook source 接进了真实 `/workflow` 执行路径。

内部接缝是一个最小 registry/provider：

- extension run 开始前先 resolve hook source
- resolve 出来的 hook set 再传给 workflow runtime
- 不通过用户配置文件暴露

---

## Internal Include 模型

`v4` 只提供插件内部 include registry：

- 来源：`src/includes/*.md`
- 用途：复用 built-in `plan/build` 的固定 prompt 片段

当前内置片段：

- `workflow-role-common`
- `plan-style`
- `build-style`

### 适用范围

- 只对 built-in agent 生效
- project / global / user-defined agent 不走这条路径
- 不支持 project includes
- 不支持 global includes
- 不支持 frontmatter `includes`

### prompt 顺序

对于 built-in agent：

1. internal include fragments
2. built-in agent 自己的 role prompt

对于用户 agent：

1. 用户 markdown body
2. runtime 动态注入的 objective / state / contract

动态上下文仍然由 `workflow-prompts.ts` 和 runtime 负责，不被抽到 include 里。

### include 读取策略

为避免运行位置变化导致 built-in prompt 失效，include loader 现在采用：

1. 优先从 package 相对目录查找 markdown fragment
2. 在找不到文件时回退到内嵌的 built-in fragment 文本

这样 built-in prompt 组合不会强依赖某一种 transpile / cache 目录结构。

---

## 模型优先级

`v4` 保持现有优先级不变：

1. `agent.model`
2. 当前 Pi session 的模型
3. Pi 默认模型

没有引入额外 config fallback。

---

## 落地文件边界

### 新增

- `src/workflow-hooks.ts`
  - hook 输入/patch 类型
  - patch merge helper
  - immutable snapshot helper
  - error patch 应用逻辑
- `src/workflow-hook-registry.ts`
  - internal hook source registry / provider resolve
- `src/workflow-prompt-composer.ts`
  - internal include 读取与 built-in prompt 组合
- `src/includes/`
  - built-in prompt fragment markdown

### 修改

- `src/agents.ts`
  - built-in `plan/build` 改为通过 internal include 组合 prompt
  - 用户 agent 加载路径保持不变
- `src/workflow-runtime.ts`
  - 接入 hook 调用点
  - 把 hook 输入改成 immutable snapshot
  - 接入 hook error 归一化
  - 保持 repair retry / merge / fail-fast
- `src/index.ts`
  - 在真实 `/workflow` 入口 resolve runtime hooks
  - 导出最小 hook registry API
- `src/workflow-types.ts`
  - 为 step state 增加 diagnostics 落点
- `src/workflow-prompts.ts`
  - 继续只负责 structured prompt / repair prompt

---

## 验收标准

只有同时满足下面几条，`/workflow v4` 才算完成：

- hook pipeline 已接入 runtime
- hook 输入是 immutable snapshot
- hook 只能 patch，不会接管 orchestrator
- 真实 `/workflow` 入口已经能 resolve internal hooks
- built-in include registry 与 prompt composer 可用
- built-in include 读取对 relocated / transpiled 执行更稳健
- built-in `plan/build` 已完成 prompt 抽取
- 用户 workflow YAML 仍然是 `string[]`
- 用户 agent 仍然是 frontmatter + prompt body
- 用户 agent 不会自动吃 built-in includes
- 模型优先级保持 `agent.model -> 当前 session -> Pi 默认`
- 文档与最小手工验证补齐
