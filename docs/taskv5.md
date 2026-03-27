# /workflow v5 Tasks

> 目标：优先 adopt Pi 已提供的高杠杆 primitives，把 `/workflow` 从 CLI-subprocess orchestration 推进到 Pi-native session / persistence / rendering 模型。

---

## 实现状态

### M1 - SDK session runner 替换 CLI subprocess

- [x] 新增 `src/workflow-agent-session.ts`
- [x] 在新模块里封装 `createAgentSession()` 与 `session.subscribe()`
- [x] 每个 workflow step 改为 child `AgentSession`
- [x] child step 默认使用 `SessionManager.inMemory()`
- [x] 继续支持 step 级别的 `cwd / model / tools / systemPromptOverride`
- [x] 继续支持 abort，并用 `session.abort()` 接管当前 kill-process 语义
- [x] 把 child session 事件映射回现有 `SingleResult.messages / usage / lastWork / stopReason / errorMessage`
- [x] 保持 `workflow-runtime.ts` 上层 hook / parser / merge / repair contract 不变
- [x] 从 `src/workflow-runtime.ts` 删除 `spawn("pi", ...)` 执行路径

### M2 - 显式 child-session resource loader

- [x] 为 child session 创建显式 `DefaultResourceLoader`
- [x] resource loader 的 `cwd` 与 workflow runtime cwd 对齐
- [x] 保留 project/global `AGENTS.md`、skills、prompts 的正常发现
- [x] 明确决定 child session 是否加载 conductor extension 本身
- [x] 如果默认发现会导致 conductor recursion 或不必要耦合，使用 override/filter 收紧 child extension 集合
- [x] 不依赖“刚好默认能跑”的隐式 discovery

### M3 - Session entry persistence

- [x] 新增 `src/workflow-session-entries.ts`
- [x] 定义 workflow custom entry payload schema
- [x] workflow run 开始时 append `workflow-run-started`
- [x] step 进入运行中时 append `workflow-step-updated`
- [x] step 完成时 append `workflow-step-finished`
- [x] workflow 完成或失败时 append `workflow-run-finished`
- [x] entry payload 只保存 serializable snapshot
- [x] extension 启动 / `session_start` 时能从当前 session entries 恢复最近一次 workflow 摘要
- [x] 非 Zellij 路径不再把 sidecar 文件当成主持久化模型
- [x] Zellij 状态文件仍保留为跨 pane 通信手段

### M4 - Workflow message renderer

- [x] 新增 `src/workflow-message-renderer.ts`
- [x] 注册 workflow 自定义 message renderer
- [x] workflow 运行期间发送结构化 workflow message
- [x] collapsed 视图显示当前 step、状态、最后进展
- [x] expanded 视图显示 blockers、decisions、verification、focus、work items 摘要
- [x] widget 继续保留为顶部总览
- [x] widget 与 renderer 改用同一份 presentation payload
- [x] `src/workflow-cards.ts` 不再自己维护另一套平行展示模型

### M5 - `/workflow` 命令体验补强

- [x] 给 `pi.registerCommand("workflow")` 增加 `getArgumentCompletions`
- [x] workflow 名称补全来自当前可发现 workflow 列表
- [x] workflow 运行时设置更可读的 session name
- [x] 如有稳定收益，记录最近一次 workflow 选择，给后续 rerun 留接口
- [x] 不因为有 `registerFlag` / `registerShortcut` 就强行把它们塞进主线

### M6 - 选择性生命周期集成

- [x] 评估 `tool_result` 是否能替代部分现有结果 glue（本次未接入，当前 SDK runner 与 workflow message path 已足够覆盖）
- [x] 评估 `before_provider_request` 是否能带来明确的 observability / policy 收益（本次未接入，暂未形成明确删码或提效收益）
- [x] 只有在能删代码或明显提效时才接入
- [x] 这部分不阻塞 `v5` 主线交付

---

## 手工验证

当前仓库约束下，`v5` 继续以手工验证为主，不新增 automated tests。

### 需要执行

- [x] `npm run typecheck`
- [ ] 在非 Zellij 路径运行一个 built-in workflow，确认 step 已不再依赖 `pi` CLI 子进程
- [ ] 验证 child session 的 streaming update 会持续刷新 `SingleResult` 与 workflow UI
- [ ] 中途 abort workflow，确认 child session 会被正确停止
- [ ] 验证 step 级 model override 仍然生效
- [ ] 验证 step 级 tool policy 仍然生效
- [ ] 验证 user-defined agent 仍然正常运行
- [ ] 验证 hook pipeline 在 SDK runner 路径上没有退化
- [ ] 验证 workflow message renderer 的 collapsed / expanded 视图
- [ ] 重新加载 extension 或重开 session，确认最近一次 workflow 摘要可恢复
- [ ] 验证 Zellij 路径仍然能显示进度并最终回传状态

### 如果遇到风险点，要特别确认

- [ ] child session 没有因为 resource discovery 把 conductor 自己递归装配成失控行为
- [ ] widget 摘要与 renderer timeline 没有出现两套不一致状态
- [x] session entries 不会把 live runtime object 或不可序列化对象写进去

---

## Done Definition

- [x] step 执行已完全切到 `createAgentSession()`
- [x] `spawn("pi")` 已从 workflow step runtime 中移除
- [x] child session resource loading 已显式控制
- [x] workflow 状态已通过 `appendEntry()` 进入 Pi session persistence
- [x] extension reload 后可恢复最近一次 workflow 摘要
- [x] workflow 已具备自定义 message renderer
- [x] widget 与 renderer 共用同一份 presentation payload
- [x] `/workflow` 至少已支持 workflow 名称补全
- [ ] hook / parser / merge / repair 现有语义没有退化
- [ ] Zellij 路径仍然可用
