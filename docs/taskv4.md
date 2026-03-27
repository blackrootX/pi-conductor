# /workflow v4 Tasks

> 目标：把 `/workflow v4` 收缩成 `hooks + internal includes`，在不改变用户 workflow/agent 公开 authoring 方式的前提下，增强 runtime 扩展性并消除 built-in prompt 重复。

`v4` 不包含：

- 公开的 `conductor.json`
- 用户可编辑 `includes`
- workflow YAML 新 schema
- config merge / precedence 设计
- teams、team-workflow、delegate runtime、background execution、DAG、resume
- auto-skip、auto-reorder、dynamic step insertion

本仓库继续遵守约束：

- 不新增测试文件
- 以 `npm run typecheck` + 手工验证为主

---

## 里程碑总览

- M1：hook types + invocation points
- M2：internal include registry + built-in prompt composer
- M3：built-in prompt extraction
- M4：docs + manual validation

---

## M1 - hook types + invocation points

### 1. 新增 hook 类型与 patch contract

- [ ] 新增 `src/workflow-hooks.ts`
- [ ] 定义：
  - [ ] `BeforeWorkflowInput` / `BeforeWorkflowPatch`
  - [ ] `BeforeStepInput` / `BeforeStepPatch`
  - [ ] `AfterStepInput` / `AfterStepPatch`
  - [ ] `OnStepErrorInput` / `OnStepErrorPatch`
  - [ ] `WorkflowRuntimeHooks`
- [ ] 明确 hook 只返回 patch，不返回完整替换对象

### 2. 实现 hook patch merge helper

- [ ] 为各类 hook 提供统一 patch merge 逻辑
- [ ] 保持 orchestrator 对 state / result / workOrder 的最终所有权
- [ ] 避免 hook 之间互相覆盖到不可解释状态

### 3. 把 hook 接入 runtime

- [ ] workflow 初始化后调用 `beforeWorkflow`
- [ ] step prompt 构建前调用 `beforeStep`
- [ ] step result parse 成功后调用 `afterStep`
- [ ] step error / repair error 路径调用 `onStepError`

### 4. 处理 hook error

- [ ] hook error 统一捕获
- [ ] 非 `onStepError` hook 抛错时，归一化成 step failure
- [ ] `onStepError` 抛错时，不覆盖原始错误，只追加 diagnostics

### 验收

- [ ] runtime 已有稳定 hook 调用顺序
- [ ] hook 不能绕过 parser / merge / fail-fast
- [ ] hook error 不会把 workflow 带进不可解释状态
- [ ] `npm run typecheck` 通过

---

## M2 - internal include registry + built-in prompt composer

### 5. 新增 internal include registry

- [ ] 新增 `src/includes/`
- [ ] 约定 internal include 只从插件内置目录读取
- [ ] 不支持 project includes
- [ ] 不支持 global includes
- [ ] 不支持用户 frontmatter `includes`

### 6. 新增 built-in prompt composer

- [ ] 新增 `src/workflow-prompt-composer.ts`
- [ ] 支持 built-in agent prompt 由 base fragments + internal includes 组合
- [ ] composer 只作用于 built-in agents
- [ ] 用户自定义 agent 继续直接使用自己的 prompt body

### 7. 保持 runtime 动态注入职责不变

- [ ] `workflow-prompts.ts` 继续负责 structured step prompt
- [ ] repair prompt 继续由 runtime 统一控制
- [ ] objective / shared state / response contract 不抽成 internal include

### 验收

- [ ] built-in include registry 可用
- [ ] built-in prompt composer 可用
- [ ] 用户 agent 路径不受影响
- [ ] `npm run typecheck` 通过

---

## M3 - built-in prompt extraction

### 8. 抽取 built-in `plan/build` 的重复文案

- [ ] 把 built-in `plan/build` 的共用 prompt 片段抽成 internal include
- [ ] 把 built-in `plan` 的 planning-only 角色片段单独抽出
- [ ] 把 built-in `build` 的 execution 角色片段单独抽出

### 9. 保持用户 agent 行为不变

- [ ] `src/agents.ts` 不新增用户 frontmatter `includes`
- [ ] 用户 agent 继续保留完整 prompt body
- [ ] runtime 不自动给用户 agent 附加 built-in role include

### 10. 确认模型优先级文档与实现一致

- [ ] built-in / user-defined agent 继续按下面优先级取模型：
  - [ ] `agent.model`
  - [ ] 当前 Pi session 模型
  - [ ] Pi 默认模型
- [ ] 不引入额外 config fallback

### 验收

- [ ] built-in `plan/build` 抽取后行为不回退
- [ ] 用户 agent prompt body 正常工作
- [ ] 用户 agent 不会自动吃 built-in role include
- [ ] 模型优先级没有被改歪

---

## M4 - docs + manual validation

### 11. 更新文档

- [ ] 重写 `docs/planv4.md`
- [ ] 重写 `docs/taskv4.md`
- [ ] 如有必要，在 `README.md` 只补一小段 `v4` 方向说明
- [ ] 文档明确说明：
  - [ ] 不做公开 `conductor.json`
  - [ ] 不做用户可编辑 `includes`
  - [ ] internal include 只服务 built-ins
  - [ ] 用户 agent 继续保留完整 prompt body

### 12. 手工验证矩阵

- [ ] `npm run typecheck`
- [ ] built-in `plan-build` 仍可运行
- [ ] built-in `plan/build` 在 include 抽取后不回退
- [ ] 用户自定义 agent prompt body 正常工作
- [ ] 用户自定义 agent 不会自动附加 built-in role include
- [ ] hook 触发顺序稳定
- [ ] hook error 路径稳定
- [ ] repair retry 路径不崩
- [ ] blocked status 仍会停止 workflow
- [ ] Zellij 渲染路径不崩
- [ ] 非 Zellij 渲染路径不崩

### 验收

- [ ] 至少走通一组 built-in workflow
- [ ] 至少走通一组用户自定义 workflow
- [ ] 至少验证一组 hook 触发场景
- [ ] 至少验证一组 hook error 场景

---

## 推荐 PR 切分

### PR 1 - Hook core

- [ ] `workflow-hooks`
- [ ] hook invocation
- [ ] hook error handling

### PR 2 - Internal include composer

- [ ] `src/includes/`
- [ ] built-in prompt composer
- [ ] runtime 接入

### PR 3 - Built-in prompt extraction

- [ ] `plan/build` prompt 抽取
- [ ] 用户 agent compatibility 验证

### PR 4 - Docs + validation

- [ ] docs
- [ ] manual validation matrix

---

## Done Definition

只有同时满足下面几条，才能算 `/workflow v4` 完成：

- [ ] hook pipeline 已稳定
- [ ] internal include registry 与 built-in prompt composer 已稳定
- [ ] built-in `plan/build` 已完成 prompt 抽取
- [ ] 用户公开 authoring 方式没有退化：
  - [ ] workflow YAML 仍然是 `string[]`
  - [ ] 用户 agent 仍然是 frontmatter + prompt body
- [ ] 用户自定义 agent 不会自动吃 built-in role include
- [ ] 模型优先级仍然是：
  - [ ] `agent.model`
  - [ ] 当前 Pi session 模型
  - [ ] Pi 默认模型
- [ ] 文档与手工验证已补齐
