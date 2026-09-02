# Agent Note: DuckDuckGo 成为出厂默认的 web 搜索

Status: implemented

[English](2026-09-02-web-search-default-duckduckgo.md) | 中文

## 问题

出厂基础组合（[`packages/bundle/base/cordis.patch.yml`](../../../packages/bundle/base/cordis.patch.yml)）将 `searchProvider` 默认为 `deepseek-official`，因此每个出厂表面（Web GUI、headless、CLI、Python SDK）要运行 `web_search` 都需要 `DEEPSEEK_API_KEY`。[无密钥 DuckDuckGo 提供方](../architecture/2026-08-21-keyless-duckduckgo-search-provider.zh.md)提供了匿名搜索，但只是 opt-in 叠加。全新安装未配置搜索密钥时，`web_search` 会在其默认路径上遇到凭据缺失的失败，而非返回结果。

## 决策

`packages/bundle/base/cordis.patch.yml` 选择 `searchProvider: duckduckgo` 并挂载 `@deepseek-ai/dsh-web-search-duckduckgo` 行。因此基础包在所有继承 base 层的 profile 中都将 DuckDuckGo 设为默认搜索。这取代了[原始出厂搜索决策](../feature/2026-07-31-web-default-search.zh.md)记录的默认搜索选择（原为 `deepseek-official`），并推翻了[无密钥 DDG 提供方笔记](../architecture/2026-08-21-keyless-duckduckgo-search-provider.zh.md)中"不要在出厂基础组合中挂载该提供方"的否决。

DeepSeek 搜索仍会与 DuckDuckGo 一并挂载并保持可选，因此偏好官方检索（或需要基于凭据的端点）的部署可通过 profile 叠加、`$DSH_WEB_SEARCH_PROVIDER` 等效变量或设置 `searchProvider: deepseek-official` 来选择。`@deepseek-ai/dsh-web-search-deepseek` 依赖保留在基础包中；DuckDuckGo 的依赖并列加入。替换默认并不会从出厂安装或发布中移除 DeepSeek 搜索。

把非官方、无密钥、基于 HTML 抓取的端点作为默认所接受的权衡：标记只是部署细节而非契约，且 DuckDuckGo 对数据中心 IP（CI、云）的限流比住宅 IP 更激进。这些部署正是当初把无密钥提供方排除在出厂默认之外的原因。被限流的部署如今会在其默认路径上遇到 anomaly 页面 `WebError`（`WEB_PROVIDER_ERROR`），应改选 `deepseek-official`。失败是结构化的，绝不会静默返回空结果集。

## 备选方案

**保留 `deepseek-official` 为默认，让 DuckDuckGo 保持 opt-in。** 已否决：这保留了"无密钥 `web_search` 应开箱即用"的需求，而这正是提供无密钥提供方的意义。

**从基础包中移除 DeepSeek 搜索。** 已否决：DeepSeek 搜索仍是提供密钥部署的一等提供方，移除会让这些部署被迫添加非默认行和依赖。

## 后果

全新安装的 `web_search` 无需搜索凭据即可工作，运行中的 Web GUI 通过其 patch 层继承基础默认。DeepSeek 搜索与现有的 `deepseek-official` 选择仍可用于基于凭据的部署。基础包同时携带两个搜索提供方，遵循"捆绑其可选默认背后的提供方"的先例。遭遇 DuckDuckGo 限流的数据中心/CI 部署在其叠加中选择 `deepseek-official`。

## 测试

基础包测试验证 patch 文件可解析并挂载其行；无密钥 DDG 提供方的单元与真实网络 e2e 套件（映射、失败词汇、HMR 安全注册）覆盖提供方本身。base patch 中选择 `duckduckgo` 即加载时默认；没有快照断言旧的默认值，因此该变更由基础包测试与提供方套件共同覆盖，真实网络查询另行单独验证。
