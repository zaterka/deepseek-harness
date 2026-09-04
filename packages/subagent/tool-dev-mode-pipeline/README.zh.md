# @deepseek-ai/dsh-tool-dev-mode-pipeline

[English](README.md) | 中文

面向开发模式（`dev-mode` agent preset）流水线的模型可见工具：按角色查询模型、按环节查询额外上下文，以及在角色已配置模型上进行角色子代理委派，并在提示词前拼接该角色已配置的额外上下文。三者均读取 `ctx.devModePipeline`（`@deepseek-ai/dsh-dev-mode-pipeline`），最后一个还通过一个已配置的 `ctx.subagents` provider 解析。

## 工具

- `devagent.get-model(role)` —— 将 `"planReview" | "implement" | "codeReview"` 解析为其已配置的 `{ provider, model, fromSessionDefault }`。仅作提示用途：`devagent.spawn` 内部会自行解析同一选择，因此先调用本工具是可选的。
- `devagent.get-context(component)` —— 将 `"planner" | "planReview" | "implement" | "codeReview"` 解析为其已配置的额外上下文（未设置时为 `''`）。之所以存在 planner 环节，是因为本插件无法像给角色子代理的提示词做拼接那样，把上下文注入主 Agent 自身的对话轮次；preset 的 persona 在规划阶段开始时会调用本工具。
- `devagent.spawn(role, prompt, label?)` —— 在为本插件实例配置的 `provider`（默认 `spawn`）上，将 `role` 作为一次性子代理启动：两个字段都已设置时使用该角色已配置的模型，否则使用会话默认模型。当该角色配置了额外上下文时，会以 `[Configured Development Mode context for <role>]\n<context>\n\n<prompt>` 的形式拼接到 `prompt` 之前。等待该次运行的结果，并始终释放该次运行，返回 `{ ok, role, provider, model, fromSessionDefault, stopReason, text, error? }`——`ok` 即 `stopReason === 'completed'`；非 completed 的结果会在 `error` 中携带提供方给出的安全诊断信息（或捕获到的错误信息），但不会使该工具调用本身失败，从而让调用方 Agent 能够读取并作出应对。未知的 `role`、缺失调用 Agent，或 `ctx.subagents.start`／`run.result`／`run.dispose` 任一被拒绝，都会以同样的方式解析为 `{ ok: false, error }`。

## 配置

| 键 | 含义 |
|---|---|
| `provider` | `devagent.spawn` 用于启动子代理的 `ctx.subagents` provider 名称，默认 `spawn`。 |

## 模型体验

### 工具 schema

#### 模型所见内容

生成的 [`devagent.get-model`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dev-mode-pipeline)、[`devagent.get-context`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dev-mode-pipeline) 与 [`devagent.spawn`](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-dev-mode-pipeline) schema。

#### Token 影响

每次父请求的固定 schema 开销：三个工具 schema。

#### KV Cache 影响

只要本插件实例的配置未变，前缀保持稳定。

### devagent.spawn 结果

#### 模型所见内容

渲染后的 JSON `{ ok, role, provider, model, fromSessionDefault, stopReason, text, error? }`；子代理的中间步骤不会传给父级。

#### Token 影响

提示词与结果会保留在父级历史中直至压缩；子代理的工作上下文留在子代理内部。

#### KV Cache 影响

仅追加；新出现的内容位于可复用请求前缀之后，不会使已有的 KV Cache 条目失效。

## 已知限制与暂缓事项

- **不支持后台或可续接委派** —— 与 `@deepseek-ai/dsh-tool-subagent` 可配置的后台模式不同，`devagent.spawn` 始终在前台等待某一角色子代理的结果。流水线的计划评审／实现／代码评审阶段按设计是同步交接。
- **不支持按子代理设置 persona 或工具过滤** —— `devagent.spawn` 除 `provider`／`model` 外不请求任何 `agentOptions`；角色始终运行部署默认的子代理 persona 与完整工具集。
