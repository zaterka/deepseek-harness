# Agent Note: 基于非官方 HTML 端点的无密钥 DuckDuckGo 搜索

Status: implemented

[English](2026-08-21-keyless-duckduckgo-search-provider.md) | 中文

## 问题

web seam 出厂的搜索后端都需要部署持有的凭证：DeepSeek 官方（出厂默认，复用 `DEEPSEEK_API_KEY`）、Exa（`EXA_API_KEY`）和 Perplexity（各自的密钥）。想要一个不配置密钥即可工作的 `web_search` 的部署没有任何 opt-in 选择。DuckDuckGo 是天然的无密钥提供方——它是提供匿名搜索的主流搜索引擎——但它没有发布稳定的无密钥搜索 API：其公开的 Instant Answer API 返回即时答案而非网页搜索结果，其 HTML 搜索端点是非官方的抓取面。

## 决策

`@deepseek-ai/dsh-web-search-duckduckgo`（`packages/web/web-search-duckduckgo`）以 id `duckduckgo` 向 `ctx.web` 注册一个无密钥 `WebSearchProvider`，与其他搜索提供方采用相同的函数／命名空间插件形状。该包为 opt-in：出厂基础组合不变（[默认搜索决策](../feature/2026-07-31-web-default-search.zh.md)保持 `searchProvider: deepseek-official`），部署通过提供方配置项加上 `searchProvider: duckduckgo` 或 `$DSH_WEB_SEARCH_PROVIDER=duckduckgo` 选择 DuckDuckGo。

请求路径为 `POST <baseURL>/html/`（默认基址 `https://html.duckduckgo.com`），携带 `q` 表单体、诚实的 `deepseek-harness/<version>` user agent，并设置 `redirect: 'error'`。POST 是 DuckDuckGo 异常检测器会应答的形式：同一端点的 GET 形式在相同 user agent 下被质询为 HTTP 202 异常页面，而 POST 形式返回结果。

响应路径用 parse5 经 `parse5-htmlparser2-tree-adapter` 解析页面。每个 `div.result` 块映射为一个来源：`a.result__a` 提供 `url` 与 `title`，携带 `result__snippet` 类的 `a`／`span` 元素提供 `snippet`，DuckDuckGo 的 `<b>` 查询词包裹折叠为纯文本。`duckduckgo.com/l/?uddg=<urlencoded>` 重定向形式的 href 解析为其解码目标，该目标本身也可以是协议相对形式。缺少标题锚点、或 URL 无法解析为绝对 http(s) URL 的块会被丢弃。端点不提供发布日期，也不提供生成答案，因此从不发出 `publishedAt`，并省略 `content`。

失败词汇即 seam 的词汇：非 2xx 响应成为附带 HTTP 状态的 `WEB_PROVIDER_ERROR`，网络失败成为 `WEB_PROVIDER_ERROR`，中止（名为 `AbortError` 的 `DOMException`）成为 `WEB_ABORTED`，重定向在访问 `Location` 目标之前成为 `WEB_PROVIDER_ERROR`。反爬异常页面是提供方失败，而不是空结果：它或以 HTTP 202 到达，或以引用质询脚本的 2xx 响应体到达，两种形式都映射为 `WEB_PROVIDER_ERROR`。没有任何 `div.result` 块的干净 2xx 页面是真实的零命中查询，解析为 `sources: []`。

配置只有一个键，`baseURL`。端点不接受结果数量参数，且只返回一个固定结果页，因此请求的 `maxResults` 由 seam 在返回路径上强制执行，提供方报告 `truncated: false`。

## 曾考虑的替代方案

**Instant Answer API。** 被否决：它返回按查询匹配的即时答案（摘要、定义），而非排序后的网页搜索结果；对 `web_search` 来说是错误的能力。

**自研解析结果 HTML。** 按依赖优于自研的政策被否决：parse5 与其 htmlparser2 树适配器——jsdom 使用的同一解析器栈——以两个受维护、零依赖的包换掉自有的标记遍历代码及其脆弱的测试。

**在出厂基础组合中挂载该提供方。** 被否决：opt-in 不进出厂默认，且数据中心 IP 的部署（CI、云端）会把 DuckDuckGo 的限流当作默认搜索路径来遭遇。

**把异常页面当作空结果集。** 被否决：异常页面是质询而非零命中查询；为它返回 `sources: []` 会在限流下静默降低搜索质量。

## 后果

想要无密钥 `web_search` 的部署现在拥有它，用两行 overlay 即可选择。提供方闭包增加两个运行时依赖（parse5、parse5-htmlparser2-tree-adapter）；没有新的凭证面，也没有环境变量。

提供方质量受制于一个标记属于部署细节而非约定的端点。标记漂移表现为来源缺失或零结果；激进限流表现为异常页面错误；数据中心 IP 比住宅 IP 更常被质询。真实网络 e2e 在端点以异常页面应答时自我跳过——这是可用性问题而非提供方缺陷——因此在被质询的网络上 CI 保持绿色，标记回归在端点可达的任何地方都会被捕获。

提供方不提供结果数量控制，也不提供分页：端点只返回一个固定结果页。更多结果页，以及提供方无关的数量语义，等待 seam 中的分页决策。

## 测试

`tests/duckduckgo.spec.ts` 基于抓取的页面 fixture（测试前置数据）固定映射行为（直接 href、`uddg` 重定向跳板、无 snippet 与无锚点的块、空白字段）、异常／HTTP／abort 失败词汇、`redirect: 'error'` 请求选项、`q` 表单体与诚实的 user agent，以及经由真实 `ctx.web` seam 的注册（HMR 安全释放、`WEB_PROVIDER_CONFIGURED_MISSING`／`UNAVAILABLE`、已配置与默认 `baseURL`）。`tests/duckduckgo.e2e.ts` 是真实网络冒烟测试：它总是运行（没有密钥门控），在端点以异常页面应答时自我跳过。
