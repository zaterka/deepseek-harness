# @deepseek-ai/dsh-web-search-duckduckgo

[English](README.md) | 中文

一个无需密钥、由 DuckDuckGo 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它将查询 `POST` 到 DuckDuckGo 的 HTML 搜索端点（`POST /html/`），把页面中的 `div.result` 块映射为 seam 规范化的 `WebSearchResult`。无需 API 密钥；可用性检查只验证端点可解析，限流以结构化提供方错误呈现，而不会变成空结果。

这是一个**实现**包：它向 `ctx.web` 注册提供方，不拥有 `ctx.web` 键，也不注册面向模型的工具（后者属于 `@deepseek-ai/dsh-tool-web`）。与 `@deepseek-ai/dsh-web-search-exa` 一样，它是函数／命名空间插件（`inject: ['web']`），负责注册后端，而非默认导出服务。

## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `baseURL` | `https://html.duckduckgo.com` | 端点基址；追加 `/html/`。无法解析时提供方不可用。 |

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: duckduckgo

- id: web-search-duckduckgo
  name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

该提供方为 opt-in：出厂基础组合保持 `searchProvider: deepseek-official`，因此选择 DuckDuckGo 需要提供方配置项加上 `searchProvider` 变更（或 `$DSH_WEB_SEARCH_PROVIDER=duckduckgo`）。

## 映射

结果页的每个 `div.result` 块映射为一个 `WebSearchSource`：`url` ← `a.result__a` 的 href、`title` ← 其文本、`snippet` ← 携带 `result__snippet` 类的 `a`／`span` 元素的文本（DuckDuckGo 用 `<b>` 包裹查询词，折叠为纯文本）。`duckduckgo.com/l/?uddg=<urlencoded>` 重定向形式的 href 在发出前先解析为其解码目标；缺少标题锚点、或 URL 无法解析为绝对 http(s) URL 的块会被丢弃。端点不提供发布日期，也不提供生成答案，因此从不发出 `publishedAt`，并省略 `content`。没有任何结果块的干净页面是真实的零命中查询，解析为 `sources: []`。

请求为携带 `q` 表单体和诚实的 `deepseek-harness/<version>` user agent 的 `POST`——端点的 `GET` 形式会被 DuckDuckGo 的异常检测器质询。异常页面——无论是限流用的 HTTP 202，还是携带质询脚本的 2xx 响应体——都以 `WebError` `WEB_PROVIDER_ERROR` 呈现，而不会成为空结果。其余失败遵循提供方约定：非 2xx 响应成为附带 HTTP 状态的 `WEB_PROVIDER_ERROR`，网络失败成为 `WEB_PROVIDER_ERROR`，被中止的请求成为 `WEB_ABORTED`，HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。请求的 `maxResults` 由 seam 在返回路径上强制执行：端点返回一个固定结果页且不接受数量控制，提供方报告 `truncated: false`。

## 模型体验

通过 [`dsh-tool-web`](../tool-web/README.zh.md) 间接影响；该工具保留此提供方经 `maxResults` 限制的 URL、标题与 snippet，或将确切的错误消息 `DuckDuckGo search aborted`、`DuckDuckGo search request failed: <error>`、`DuckDuckGo API error (HTTP <status>)` 和 `DuckDuckGo returned an anomaly challenge page (request rate-limited)` 置于消费方的错误包装层内；原始结果页与提供方私有字段不进入上下文。

#### KV Cache 影响

不会直接导致 KV Cache 失效；请求前缀变更由上述消费方负责。

## 已知限制与暂缓事项

- **非官方端点**——DuckDuckGo 未发布无密钥搜索 API（其公开的 Instant Answer API 返回即时答案而非网页搜索结果），因此 HTML 端点的标记是部署细节而非约定。标记漂移表现为来源缺失或零结果；激进限流表现为异常页面错误。真实网络 e2e 在端点以质询应答时自我跳过，因此在端点可达的任何地方都会捕获标记回归。
- **无结果数量或分页控制**——端点返回一个固定结果页且不接受数量参数；seam 的 `maxResults` 在返回路径上截断。更多结果页等待 seam 中的提供方无关分页语义。
- **按错误形状分类中止**——只有名为 `AbortError` 的 `DOMException` 才映射为 `WEB_ABORTED`；携带自定义原因的中止（例如 `dsh-timeout` 的 `TimeoutReason`）会呈现为 `WEB_PROVIDER_ERROR`。
