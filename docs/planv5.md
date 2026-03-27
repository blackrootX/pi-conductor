# /workflow v5 Plan

## 目标

`v5` 不再优先扩 `/workflow` 自己的私有 runtime 逻辑，而是把最重的几块能力直接切到 Pi 已经提供的 primitives 上。

核心判断很简单：

- 现在最大的自定义接缝，是 step 执行仍然靠 `spawn("pi", ...)`
- 现在最弱的持久化接缝，是 workflow 进度没有真正落进 Pi session 自己的 entry 模型
- 现在最弱的展示接缝，是 workflow 状态主要靠 widget 和纯文本，而不是 Pi 原生 message renderer

所以 `v5` 的主题不是“多用一点 Pi API”，而是“先 adopt 那些能直接替换我们现有重型 glue code 的 Pi API”。

---

## 这次要 Adopt 的 Pi 能力

按优先级排序，建议 adopt 下面几项：

1. `createAgentSession()` + `AgentSession.subscribe()`
2. `DefaultResourceLoader` 及其 override 能力
3. `pi.appendEntry()`
4. `pi.registerMessageRenderer()` + `pi.sendMessage()`
5. `/workflow` command completions，以及少量 session UX API
6. `tool_result` / `before_provider_request`

### 1. `createAgentSession()` + `AgentSession.subscribe()`

这是 `v5` 的主轴。

当前 step 执行路径仍然是：

- runtime 组装命令行参数
- `spawn("pi", ["--mode", "json", "-p", "--no-session", ...])`
- 手工解析 stdout JSON line 事件
- 再把这些事件翻译回自己的 `SingleResult`

这个接缝的代价很高：

- 多一层子进程边界
- 多一层 CLI 协议解析
- abort / streaming / usage 统计都要自己粘
- runtime 对 Pi 的 session 能力基本完全不可见

`v5` 应该把每个 workflow step 改成 SDK 内嵌 session：

- 每个 step 创建一个 child `AgentSession`
- 通过 `session.subscribe()` 接收消息、tool、usage、结束事件
- 直接把 session event 映射成现有 `SingleResult`
- 用 `session.abort()` 替代杀子进程

这项改动的收益最大，也最能减少现有自定义 glue。

### 2. `DefaultResourceLoader` + override

一旦 step 改成内嵌 session，下一件事不是“照搬默认发现”，而是明确 child session 到底要加载什么。

`v5` 应该显式管理 child session 的 resource loading：

- `cwd` 必须对齐 workflow step 的工作目录
- `AGENTS.md` / skills / prompt templates 继续通过 Pi 的 resource model 进入 child session
- extension discovery 不能完全放任默认行为
- 必须能过滤或覆盖 child session 的 extension 集合，避免 conductor runtime 自己递归耦合到自己

也就是说，`v5` adopt 的不只是 `createAgentSession()`，而是“显式 resource loader + 明确的 child session 装配策略”。

### 3. `pi.appendEntry()`

现在 workflow 的状态主要体现在：

- runtime 内存对象
- widget 状态
- Zellij 下的状态文件

这些都不是 Pi session 自己的持久化语义。

`v5` 应该把 workflow 运行轨迹落进当前 session entry：

- workflow 开始
- step 开始
- step update
- step 完成
- workflow 完成 / 失败

这样做的好处：

- extension reload 后可以恢复最近的 workflow 摘要
- workflow timeline 不再只是瞬时 UI
- 恢复逻辑不必完全依赖额外 sidecar 文件

注意：`appendEntry()` 不参与 LLM context，这正适合 workflow bookkeeping。

### 4. `pi.registerMessageRenderer()` + `pi.sendMessage()`

现在 workflow 的可视化主要靠：

- `setWidget()`
- tool/result 的普通文本输出

这足够“能看”，但不够 Pi-native。

`v5` 应该增加 workflow 专用消息类型和 renderer：

- 用 `pi.sendMessage()` 发送结构化 workflow 进度消息
- 用 `pi.registerMessageRenderer()` 渲染 collapsed / expanded 视图
- widget 保留为顶部摘要卡片
- message renderer 负责 timeline、diagnostics、verification、blockers、latest work

目标不是替换 widget，而是让 widget 和 renderer 共用同一份 presentation payload。

### 5. `/workflow` command completions + session UX

这一层属于小而稳的 Pi 采纳项：

- 给 `pi.registerCommand("workflow")` 增加 `getArgumentCompletions`
- workflow 启动时可以 `pi.setSessionName(...)`
- 如果“重跑上一次 workflow”真的有稳定收益，再考虑一个 shortcut

这一层不该反过来主导 v5，只做低风险增益。

### 6. `tool_result` / `before_provider_request`

这两类 lifecycle event 值得关注，但不应该一开始就把它们塞成 `v5` 主线。

使用原则应该很克制：

- 只有当它们能删掉现有 glue code，才 adopt
- 只有当它们能明显改善 observability / policy，才 adopt

所以这项更像 `v5.x` 候选，而不是 `v5` 启动条件。

---

## v5 主线范围

`v5` 建议只把下面四项作为主线交付：

1. SDK-backed step session runner
2. 显式 child-session resource loader
3. 基于 `appendEntry()` 的 workflow persistence
4. 基于 message renderer 的 workflow timeline UI

下面这些只做顺手增强，不单独拉大 scope：

- `/workflow` argument completions
- `pi.setSessionName(...)`
- 必要时保留现有 widget 作为顶部摘要

下面这些继续延后：

- 广泛使用 `registerFlag`
- 全面重写成自定义 TUI
- 使用 Pi tree/fork/session navigation 做 workflow branching
- 公开新的 workflow config schema
- 新增 automated tests

---

## Child Session 模型

### step 执行方式

每个 workflow step 都运行在一个 SDK child session 里，而不是一个 `pi` CLI 子进程里。

推荐约束：

- child step session 默认使用 `SessionManager.inMemory()`
- workflow-level 持久化通过 parent session entries 解决
- 不为每个 step 生成独立 session 文件

### 输入映射

当前 runtime 已经有这些 step 输入：

- `cwd`
- `model`
- `tools`
- `systemPromptOverride`
- `task`
- `abort signal`

`v5` 应保持这些外部 contract 不变，只把内部执行器换成 SDK session。

### 输出映射

child session 的事件流最终仍然要回到当前 runtime 结构：

- `messages`
- `usage`
- `lastWork`
- `stopReason`
- `errorMessage`
- `elapsedMs`

也就是说，`workflow-runtime.ts` 上层不应该因为执行器从 CLI 换成 SDK，就被迫整体改写。

---

## Persistence 模型

`v5` 建议定义一组稳定的 workflow custom entry：

- `workflow-run-started`
- `workflow-step-updated`
- `workflow-step-finished`
- `workflow-run-finished`

这些 entry 只保存 serializable snapshot，不保存 live runtime object。

恢复模型：

- extension 启动或 `session_start` 时扫描当前 session entries
- 找到最近一次 workflow run 的最后状态
- 恢复 widget / timeline 的摘要数据

Zellij 状态文件仍可保留，但只作为跨 pane 通信手段，而不是非 Zellij 路径的主持久化模型。

---

## Rendering 模型

`v5` 需要一个共享的 workflow presentation payload，让下面两条路径都吃同一份数据：

1. `workflow-cards.ts` 的顶部 widget
2. workflow message renderer 的 timeline / expanded details

这样可以避免：

- widget 有一套字段
- tool result 有另一套字段
- 未来 timeline renderer 再造第三套字段

建议把“展示态”从 runtime 计算里拆出来，形成独立的 presentation helper。

---

## Command Ergonomics 模型

`/workflow` 至少应该补上两点：

- workflow 名称补全
- 当用户已经输入 workflow 名称后，剩余参数按 task 文本处理，不再猜测第二段结构

如果实现成本低，还可以顺手做：

- 运行 workflow 时设置 session name
- 在当前 session 记录“最近一次 workflow 选择”

但这些都不应该阻塞主线。

---

## 明确不做

`v5` 不做下面这些事情：

- 把整个插件改写成纯 SDK app
- 把每个 workflow step 做成持久 child session 文件
- 引入新的公开 workflow schema
- 引入 DAG / resume / branching
- 公开 expose 更多 end-user config
- 因为用了 SDK 就顺手 adopt 所有 extension API
- 为了 `v5` 额外写 automated tests

---

## 落地文件边界

### 新增

- `src/workflow-agent-session.ts`
  - child session 创建
  - resource loader 装配
  - session event 到 `SingleResult` 的映射
- `src/workflow-session-entries.ts`
  - `appendEntry()` payload schema
  - restore / snapshot helper
- `src/workflow-message-renderer.ts`
  - workflow 自定义消息类型
  - renderer
  - shared message payload helper

### 修改

- `src/workflow-runtime.ts`
  - 用 SDK session runner 替换 `spawn("pi")`
  - 保持 hook / parser / merge / repair 主循环
- `src/index.ts`
  - 注册 renderer
  - workflow 运行时写入 session entries
  - `/workflow` argument completions
  - 可选的 `setSessionName(...)`
- `src/workflow-cards.ts`
  - 改吃共享 presentation payload
- `src/workflow-types.ts`
  - 增加 entry payload / presentation payload 类型
- `src/workflow-state.ts`
  - 补充从 snapshot 恢复时需要的最小展示数据计算

---

## 验收标准

只有同时满足下面几条，`/workflow v5` 才算完成：

- step 执行不再依赖 `spawn("pi")`
- child step 已通过 `createAgentSession()` 运行
- child session 的 resource loading 是显式控制的
- workflow 进度已写入 Pi session entries
- extension reload 后能恢复最近一次 workflow 摘要
- workflow timeline 已能通过 message renderer 查看
- widget 与 renderer 使用同一份 presentation payload
- `/workflow` 命令至少支持 workflow 名称补全
- 现有 hook / parser / merge / repair 语义没有退化
- Zellij 路径没有被破坏
