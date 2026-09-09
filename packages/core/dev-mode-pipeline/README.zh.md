# @deepseek-ai/dsh-dev-mode-pipeline

[English](README.md) | 中文

为开发模式（Development Mode）流水线提供按角色的模型选择与按环节的提示词上下文：`dev-mode` preset 的规划者（主 Agent）、计划评审、实现与代码评审各环节读取的、由 settings 支撑的存储。`DevModePipelineConfig` 提供 `ctx.devModePipeline`。

流水线包含四个环节：`planner`（会话自身的主 Agent，对应第 1 阶段以及第 3 阶段中作为编码协调者的部分），以及三个可派生的角色——`planReview`、`implement`、`codeReview`——由 `@deepseek-ai/dsh-tool-dev-mode-pipeline` 的 `devagent_spawn` 工具作为子代理启动。每个角色拥有独立的模型选择；四个环节各自拥有独立的额外提示词上下文。

- `ctx.devModePipeline.modelFor(role, defaultModel)` 解析某一角色的提供方／模型：当两个字段都已设置时使用已存储的选择，否则使用 `defaultModel.currentSelection()`（若未挂载默认模型服务则返回空选择）。返回值中的 `fromSessionDefault` 标记指明结果来源。
- `ctx.devModePipeline.contextFor(component)` 返回某一环节已存储的额外上下文，未设置时返回 `''`。
- `ctx.devModePipeline.saveModel(role, selection)` 与 `ctx.devModePipeline.saveContext(component, context)` 通过设置命名空间 `dev-mode-pipeline` 持久化。提供方或模型留空会清除该角色的覆盖值；持久化生效需要挂载设置提供方，这与 `@deepseek-ai/dsh-agent-default-model` 的模式一致。

设置页面本身——包括 Models 与 Prompts 两个标签页以及模型目录的联接——由 `@deepseek-ai/dsh-client-ui-settings-dev-mode-pipeline` 持有。本包只负责数据本身及其解析规则。

`DEV_MODE_BASELINE_PROMPTS` 是设置界面中展示在每个环节额外上下文字段旁的说明性文本；它不会发送给任何模型，也不会被还原进角色子代理的实际提示词——后者由调用方 Agent 自行撰写。

## 模型体验

无，因为该服务只存储与解析配置；调用方 Agent（`@deepseek-ai/dsh-tool-dev-mode-pipeline`）决定哪些内容进入模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- 该服务只拥有一份进程级设置文档；不存在按会话覆盖某一角色模型或某一环节上下文的机制。
- 未挂载设置提供方时，`saveModel()`／`saveContext()` 为空操作，每个角色都停留在会话默认模型上。
