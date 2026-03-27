# /workflow v4 Tasks

> 目标：把 `/workflow v4` 收缩成 `hooks + internal includes`，在不改变用户 workflow/agent 公开 authoring 方式的前提下，增强 runtime 扩展性并消除 built-in prompt 重复。

---

## 实现状态

### M1 - hook types + invocation points

- [x] 新增 `src/workflow-hooks.ts`
- [x] 定义 `BeforeWorkflowInput / BeforeWorkflowPatch`
- [x] 定义 `BeforeStepInput / BeforeStepPatch`
- [x] 定义 `AfterStepInput / AfterStepPatch`
- [x] 定义 `OnStepErrorInput / OnStepErrorPatch`
- [x] 定义 `WorkflowRuntimeHooks`
- [x] hook contract 只返回 patch，不返回完整替换对象
- [x] hook 输入改为 immutable snapshot，不暴露 live runtime object
- [x] 实现 shared state / work order / result / error patch merge helper
- [x] workflow 初始化后调用 `beforeWorkflow`
- [x] step prompt 构建前调用 `beforeStep`
- [x] step result parse 成功后调用 `afterStep`
- [x] step error / repair error 路径调用 `onStepError`
- [x] 统一捕获 hook error
- [x] `beforeStep` / `afterStep` hook 抛错时归一化成 step failure
- [x] `onStepError` hook 抛错时只追加 diagnostics，不覆盖原始错误
- [x] 新增 `src/workflow-hook-registry.ts`
- [x] 真实 `/workflow` 入口现在会先 resolve internal hooks，再传给 runtime

### M2 - internal include registry + built-in prompt composer

- [x] 新增 `src/includes/`
- [x] internal include 只从插件内置目录读取
- [x] 不支持 project includes
- [x] 不支持 global includes
- [x] 不支持用户 frontmatter `includes`
- [x] 新增 `src/workflow-prompt-composer.ts`
- [x] 支持 built-in agent prompt 由 internal includes + role prompt 组合
- [x] include loader 对 transpiled / relocated 执行目录增加路径探测与内嵌 fallback
- [x] composer 只作用于 built-in agents
- [x] 用户自定义 agent 继续直接使用自己的 prompt body
- [x] `workflow-prompts.ts` 继续负责 structured step prompt
- [x] repair prompt 继续由 runtime 统一控制
- [x] objective / shared state / response contract 不抽成 internal include

### M3 - built-in prompt extraction

- [x] 把 built-in `plan/build` 共用 prompt 片段抽成 internal include
- [x] 把 `plan` 的 planning-only 片段单独抽出
- [x] 把 `build` 的 execution 片段单独抽出
- [x] `src/agents.ts` 没有新增用户 frontmatter `includes`
- [x] 用户 agent 继续保留完整 prompt body
- [x] runtime 不会自动给用户 agent 附加 built-in role include
- [x] 模型优先级仍然是 `agent.model -> 当前 Pi session -> Pi 默认模型`
- [x] 没有引入额外 config fallback

### M4 - docs + validation

- [x] 重写 `docs/planv4.md`
- [x] 重写 `docs/taskv4.md`
- [x] 在 `README.md` 补充一小段 `v4` 方向说明
- [x] 文档明确说明不做公开 `conductor.json`
- [x] 文档明确说明不做用户可编辑 `includes`
- [x] 文档明确说明 internal include 只服务 built-ins
- [x] 文档明确说明用户 agent 继续保留完整 prompt body

---

## 手工验证

### 已执行

- [x] `npm run typecheck`
- [x] 编译到临时目录后，验证 built-in `plan/build` prompt 会加载 internal include
- [x] 在隔离临时项目里验证用户自定义 agent 仍然直接使用自己的 prompt body，且没有 `internalIncludes`
- [x] 直接调用 `mergeAfterStepPatch`，验证 patch merge 与 status 升级逻辑
- [x] 直接调用 `runWorkflowByName(..., hooks)`，验证：
  - [x] `beforeWorkflow` patch 会写入 shared state
  - [x] `beforeStep` 抛错会被归一化成 step failure
  - [x] `onStepError` patch 会追加 diagnostics / blocker / summary
- [x] 验证 hook snapshot 是只读的，原地 mutation 会抛错且不会污染 runtime state
- [x] 在不复制 markdown include 文件的临时编译产物里，built-in prompt 仍能通过 fallback 正常加载
- [x] 从 package root 导出的 hook registry API 可用，并能 resolve 出 hook set

### 受环境限制，未执行

- [ ] 真实 `pi` runtime 下完整跑通 built-in `plan-build`
- [ ] 真实 `pi` runtime 下验证 repair retry 路径
- [ ] 真实 `pi` runtime 下验证 blocked status 停止行为
- [ ] Zellij 渲染路径
- [ ] 非 Zellij 实时 UI 渲染路径

当前环境里 `pi` 命令不存在，所以以上几项没有伪造为已完成。

---

## Done Definition

- [x] hook pipeline 已稳定接入
- [x] hook 输入已变成 immutable snapshot
- [x] 真实 `/workflow` 入口已接入 internal hook resolve
- [x] internal include registry 与 built-in prompt composer 已稳定接入
- [x] built-in include 读取已对 relocated / transpiled 执行做加固
- [x] built-in `plan/build` 已完成 prompt 抽取
- [x] 用户公开 authoring 方式没有退化
- [x] 用户自定义 agent 不会自动吃 built-in role include
- [x] 模型优先级保持不变
- [x] 文档已补齐
- [ ] `pi` / Zellij 端到端运行验证仍需在具备对应环境时补跑
