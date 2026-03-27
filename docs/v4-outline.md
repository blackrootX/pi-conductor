# /workflow v4 Outline

## 目标

在 `v3` 完成 orchestrator intelligence 之后，`v4` 再回到 runtime extensibility。

`v4` 只做扩展性基础设施，不做 teams、team-workflow、delegate runtime、background execution model、DAG 或 resume。

换句话说：

- `v3` 解决的是 objective builder / work items / merge / projection
- `v4` 解决的是 config / hooks / includes

---

## Public additions

- 项目级配置 `.pi/conductor.json`
- 全局配置 `${getAgentDir()}/conductor.json`
- agent frontmatter `includes`
- optional step-level `includes`

---

## 配置范围

`v4` 的 config 先覆盖这些字段：

- default model override
- step timeout
- max turns
- disabled agents
- UI toggles
- projection caps
- structured response contract tuning

### 优先级

- built-in defaults
- global config
- project config

---

## Minimal hooks

`v4` 先只做最小 hook 面：

- `beforeWorkflow(state, config)`
- `beforeStep(workOrder, state)`
- `afterStep(result, state)`
- `onStepError(error, state)`

### 约束

- hooks 只能 augment 数据
- hooks 不能绕开 orchestrator 对 state 的所有权
- hooks 不能直接替换 workflow 主循环

---

## Skill / Include 机制

`v4` 的 include 只做 text include，不做可执行 plugin/tool loading。

### 来源

- built-in defaults
- global includes
- project includes
- agent includes
- step includes

### 拼装顺序

prompt 按固定顺序拼装：

1. built-in defaults
2. global includes
3. project includes
4. agent includes
5. step includes

### 目标

- 让 prompt 可复用
- 让 built-in `plan/build` 能抽到共享 includes
- 为后续 skill/context 演进留接口

---

## 非目标

`v4` 明确不做：

- teams
- team-workflow
- delegate/category/task runtime
- background execution model
- workflow YAML 新 schema
- auto-skip / auto-reorder / dynamic step insertion
- 插件 runtime 桥接

---

## 里程碑

### M1 - Config loader

- config schema
- config validation
- global/project precedence
- runtime config access

### M2 - Hook pipeline

- runtime hook registration
- hook invocation points
- hook error handling

### M3 - Include loader + prompt composer

- include discovery
- include merge order
- prompt composition pipeline

### M4 - Built-in extraction + docs

- built-in `plan/build` 抽到共享 includes
- config/include 示例
- 手工验证矩阵

---

## 假设

- `v4` 继续遵守仓库约束，不写测试文件。
- `v4` 建立在 `v3` 的 generic orchestrator / work-item state 之上。
- oh-my-openagent 仅作为设计参考，不作为直接依赖或桥接 runtime。
