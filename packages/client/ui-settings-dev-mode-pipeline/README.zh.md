# @deepseek-ai/dsh-client-ui-settings-dev-mode-pipeline

[English](README.md) | 中文

开发模式（Development Mode）设置页面。注册一个 `settings.section`（id 为 `dev-mode-pipeline`，导航标签为 "Development Mode"），内含两个标签页：

- **Models（模型）**——为每个可派生的流水线角色（`planReview`、`implement`、`codeReview`）提供一个提供方／模型选择器，数据来自主机侧的模型目录（`llm.models`）。任一下拉框选择 "会话默认" 会清除已存储的覆盖值，使该角色在派生时改为读取会话模型。规划与编码协调阶段是会话自身的 Agent，此处不可配置。
- **Prompts（提示词）**——为每个流水线环节（`planner`、`planReview`、`implement`、`codeReview`）提供一行，展示该环节只读的基线提示词文本，旁边配有可编辑的“额外上下文”字段。文本框内容变更后在失焦时保存。

两个标签页均派生自同一个 `DevModePipelineSettingsStore`，它通过共享的 settings scope（`ctx.settingsScope`，`@deepseek-ai/dsh-client-ui-settings`）绑定流水线的 `dev-mode-pipeline` 设置命名空间——与 `@deepseek-ai/dsh-client-ui-settings-models` 用于自身命名空间的方式相同——并独立加载主机侧模型目录。每次写入都通过 `SettingsScope.set` 进行，因此另一标签页的并发写入或对 `settings.yaml` 的外部编辑会被拒绝，随后本页重新加载。加载完成后，本页会在收到推送的 `settings/document-updated`、`llm/adapters-updated` 所有者事件以及本地 `connection/reset` 时刷新，与 `ui-settings-models` 对自身页面的做法完全一致。

流水线的命名空间形状、角色／环节键，以及基线提示词文案，在 `src/pipeline-copy.ts` 中被镜像维护，而非从 `@deepseek-ai/dsh-dev-mode-pipeline` 导入——这与 `ui-settings-models` 的 `onboarding-copy.ts` 对自身命名空间字面量所遵循的约定一致，因为客户端插件包只依赖其他 `@deepseek-ai/dsh-client-*` 包以及少数通用的 wire 包。当流水线的键发生变化时，需要同步更新两侧。

## 模型体验

无，因为该插件渲染的是浏览器设置界面；此处不会触达任何模型请求。

#### KV Cache 影响

无；本包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- Prompts 标签页仅展示四个固定的流水线环节；若某 preset 对 `@deepseek-ai/dsh-dev-mode-pipeline` 中的角色进行了重命名或增补，需要同步更新本包的文案。
- 远程（非 loopback）浏览器完全无法写入流水线的设置命名空间——settings scope 始终停留在其 `memory` 模式，每次写入都是本地空操作，与其它所有由 settings 支撑的页面一致。
