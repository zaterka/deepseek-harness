# Agent Note：开发模式流水线（按角色模型、按环节提示词上下文）

Status: implemented

[English](2026-09-03-dev-mode-pipeline.md) | 中文

## 问题

某团队希望有一个编码 Agent，为每个任务运行一条固定的四阶段流水线——规划、计划评审、受控编码、代码评审——其中计划评审、实现与代码评审三个阶段各自作为子代理派生，运行在各自可配置的模型上，并且可以在不修改 preset 本身的前提下，为四个阶段中的任意一个注入团队或项目专属的额外上下文。现有的 preset 或插件都没有组合出这样的流水线，settings 界面也没有任何地方可以按流水线角色挑选模型或添加上下文。

该功能的早期版本是以会话本地的动态 Cordis 包（`cordis_define`／`cordis_run`）加上用户 `~/.dsh/.agent-presets/` 下自行编写的 preset 实现的。二者都只存在于运行中的进程与用户主目录中：都不属于受 git 追踪的应用程序，因此进程重启或全新的代码检出会将其彻底丢失，也没有任何东西可以提交给团队共享。

## 决定

该流水线以三个普通的工作区包外加一个 preset 的形式随产品发布，方式与 `agent-default-model` 已经发布一份按部署配置的模型默认值完全一致：

- [`@deepseek-ai/dsh-dev-mode-pipeline`](../../../../packages/core/dev-mode-pipeline/README.zh.md)（`ctx.devModePipeline`）持有数据：一个设置命名空间（`dev-mode-pipeline`），为每个可派生角色（`planReview`、`implement`、`codeReview`）存储一份 `{ provider, model }`，并为每个流水线环节（这三个角色加上 `planner`，即主 Agent 阶段）存储一份额外上下文字符串。`modelFor(role, defaultModel)` 将某一角色的模型解析为：两个字段都已设置时使用已存储的选择，否则使用传入的 `agentDefaultModel` 服务当前的选择——这正是 `installSettingsSection` 已经赋予 `agent-default-model` 的同一套 settings 分层模式，此处直接复用而非重新发明。
- [`@deepseek-ai/dsh-tool-dev-mode-pipeline`](../../../../packages/subagent/tool-dev-mode-pipeline/README.zh.md) 是 agent 层的消费方：三个模型可见工具（`devagent.get-model`、`devagent.get-context`、`devagent.spawn`）读取 `ctx.devModePipeline`；其中 `devagent.spawn` 会通过一个已配置的 `ctx.subagents` provider，以该角色解析出的模型启动一个角色子代理，并把该角色的额外上下文拼接到提示词之前。
- [`@deepseek-ai/dsh-client-ui-settings-dev-mode-pipeline`](../../../../packages/client/ui-settings-dev-mode-pipeline/README.zh.md) 注册一个带两个标签页的 `settings.section`——Models（每个角色一个提供方／模型选择器，数据来自主机侧的 `llm.models` 目录）与 Prompts（每个环节的只读基线提示词旁配有可编辑的额外上下文字段）——通过与 `ui-settings-models` 绑定自身命名空间相同的共享 `ctx.settingsScope` seam，绑定到同一设置命名空间。
- `dev-mode` 随产品发布的 preset（`apps/cli/config/agent-presets/dev-mode/`）提供四阶段 persona，并在常规编码工具集（shell、文件系统、jobs、skills、goals、plan mode、delegation、web）之外加载 `tool-dev-mode-pipeline`——与 `standard`／`code` preset 的结构相同。

主机层划分：`dev-mode-pipeline` 挂载在 base bundle（`packages/bundle/base/cordis.patch.yml`）中，与 `agent-default-model` 并列，因此无论是否有任何会话挂载 `dev-mode` preset，其 settings 以及不依赖 RPC 的 `ctx.devModePipeline` 读写路径都始终存在——settings 页面不应依赖某个特定 preset 处于激活状态。`tool-dev-mode-pipeline` 则保留在 agent 层，只由 `dev-mode` preset 加载，因为它注册的工具若脱离该 preset 用来驱动各流水线阶段的 persona，便毫无意义。

`planner` 环节的额外上下文无法像派生角色那样被拼接进去，因为 planner 本身**就是**主 Agent，并非本插件启动的对象——不存在可供拼接的提示词。为此存在 `devagent.get-context` 供主 Agent 主动调用，`dev-mode` persona 在 PLAN 阶段开始时会显式调用它并将结果并入。

## 已考虑的替代方案

**继续以动态 Cordis 包 + `~/.dsh/.agent-presets/` preset 作为发布形态。** 已拒绝：二者都无法在进程重启或全新检出后存活，因而无法被代码评审、纳入版本管理或与团队共享——这恰恰正是触发本次工作的需求。

**用一个合并包代替三个包。** 已拒绝：这会重复本仓库自身 capability-seam 约定本应防止的错误——持有 settings 的服务、面向模型的工具消费方、以及浏览器设置页面是三个会独立演化的角色（settings schema 的变更不应牵动工具 schema 的重建，反之亦然），因此沿用 `agent-default-model` / `tool-subagent` / `ui-settings-models` 既有的三方拆分，而不是发明新的形态。

**为设置页面使用定制的 Client→Host RPC，而非通用的 settings scope。** 已拒绝：`ctx.settings`（`@deepseek-ai/dsh-settings`）及其客户端侧的 `ctx.settingsScope` 镜像已经解决了命名空间分层、脱敏、修订号防并发写入以及推送式失效通知；定制 RPC 只会为通用 seam 已经满足的需求重复实现这一切。

**把 planner 的额外上下文直接并入 preset 的静态 persona 文本，而非通过工具调用。** 已拒绝：persona 是编译进 preset 的一段固定字符串；它没有办法在不调用工具的情况下读取运行期的 settings 值，而另一种做法——每次 planner 上下文变化时重新生成 preset 文件——则违背了让它可以从 Settings 中编辑的初衷。

## 后果

该流水线及其按角色的模型、按环节的额外上下文都是普通的、受 git 追踪的源码：它们像其他任何包一样构建、类型检查、lint 与测试，随与 `agent-default-model` 相同的 bundle 发布，并能在重启与全新检出后存活。从未加载 `dev-mode` preset 的部署仍会在 base bundle 中携带（未使用的）`dev-mode-pipeline` settings 命名空间，正如它本已携带 `agent-default-model` 的命名空间一样。新增第五个流水线阶段或角色，需要同步更新三个包共用的词汇（主机侧包中的 `DevModeComponent`／`DevModeRole`，以及客户端包 `pipeline-copy.ts` 中作为纯数据镜像的同名类型——按照客户端包不得导入主机侧 `@deepseek-ai/dsh-*` 包的纯净性规则）以及 preset 的 persona——Host／Client 边界两侧并不存在单一的事实来源，这与 `ui-settings-models` 自身命名空间字面量在 `onboarding-copy.ts` 中已经接受的权衡相同。

## 测试

[`dev-mode-pipeline.spec.ts`](../../../../packages/core/dev-mode-pipeline/tests/dev-mode-pipeline.spec.ts) 在一个真实的内存版 `SettingsProvider` 之上驱动 `DevModePipelineConfig`，覆盖默认模型回退、已保存的覆盖值、清除覆盖值、手写的部分 settings 分节、provider 卸载，以及未挂载 settings provider 的情形——与 `agent-default-model.spec.ts` 的覆盖形态一致。

[`tool-dev-mode-pipeline.spec.ts`](../../../../packages/subagent/tool-dev-mode-pipeline/tests/tool-dev-mode-pipeline.spec.ts) 在真实的 `ToolRuntime` + `SubagentRuntime` + `DevModePipelineConfig` 上启动真实的插件主体，用一个包内本地的脚本化子代理 provider（扩展了 `startRejection`／`resultRejection`／`disposeRejection` 钩子）充当子代理边界，并通过 `ctx.tools.execute` 调用每个工具：模型／上下文解析及其对未知角色／环节的拒绝、上下文被（或未被）拼接进派生提示词、非 completed 的结束原因在不使工具调用失败的前提下被上报，以及 `ctx.subagents.start`／`run.result`／`run.dispose` 每一种失败组合。

[`apply.client.spec.ts`](../../../../packages/client/ui-settings-dev-mode-pipeline/tests/apply.client.spec.ts) 证明了 slot 注册、随语言环境变化的导航标签、HMR 重新注册，以及推送式失效刷新，镜像了 `ui-settings-models` 自身的 `apply.client.spec.ts`。[`store.client.spec.ts`](../../../../packages/client/ui-settings-dev-mode-pipeline/tests/store.client.spec.ts) 在一个真实的、由 mirror 派生的 `SettingsScopeController` 与一个脚本化的 `llm.models` 接口之上驱动页面 store。[`components.client.spec.tsx`](../../../../packages/client/ui-settings-dev-mode-pipeline/tests/components.client.spec.tsx) 在一个被 stub 的 settings scope 之上渲染带标签页的 section，覆盖两个标签页、每条保存路径（成功与失败、Error 与非 Error 的拒绝），以及只读提示。[`pipeline-copy.client.spec.ts`](../../../../packages/client/ui-settings-dev-mode-pipeline/tests/pipeline-copy.client.spec.ts) 详尽覆盖了异常线上数据的解码分支。三个新包均达到按文件 100% 的覆盖率。
