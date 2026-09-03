# @deepseek-ai/dsh-web-search-duckduckgo

English | [中文](README.zh.md)

A keyless `WebSearchProvider` for the harness [web capability seam](../web/README.md) (`ctx.web`) backed by DuckDuckGo. It posts the query to DuckDuckGo's HTML search endpoint (`POST /html/`) and maps the page's `div.result` blocks into the seam's normalized `WebSearchResult`. It needs no API key; availability is a parseable-endpoint check, and rate limiting shows up as a structured provider error, never as an empty result.

This is an **implementation** package: it registers a provider into `ctx.web`, it does not own the `ctx.web` key and it does not register a model-facing tool (that is `@deepseek-ai/dsh-tool-web`). Like `@deepseek-ai/dsh-web-search-exa`, it is a function/namespace plugin (`inject: ['web']`) that registers its backend, not a default-export service.

## Config

| Key | Default | Meaning |
|---|---|---|
| `baseURL` | `https://html.duckduckgo.com` | Endpoint base; `/html/` is appended. An unparseable value makes the provider unavailable. |

```yaml
- id: web
  name: '@deepseek-ai/dsh-web'
  config:
    searchProvider: duckduckgo

- id: web-search-duckduckgo
  name: '@deepseek-ai/dsh-web-search-duckduckgo'
```

The provider is the shipped default: the base composition selects `searchProvider: duckduckgo` and mounts this row. DeepSeek search stays mounted alongside it, so a deployment that prefers official retrieval sets `searchProvider: deepseek-official` (or `$DSH_WEB_SEARCH_PROVIDER=deepseek-official`).

## Mapping

Each `div.result` block of the results page maps to one `WebSearchSource`: `url` ← the href of `a.result__a`, `title` ← its text, `snippet` ← the text of the `a`/`span` element carrying the `result__snippet` class (DuckDuckGo wraps query terms in `<b>`, which collapses to plain text). Hrefs in the `duckduckgo.com/l/?uddg=<urlencoded>` redirect form are resolved to their decoded target before emission; blocks without a title anchor, or whose URL cannot be resolved to an absolute http(s) URL, are dropped. The endpoint carries no publication dates and no generated answer, so `publishedAt` is never emitted and `content` is omitted. A clean page with zero result blocks is a genuine zero-hit query and resolves to `sources: []`.

The request is a `POST` with a `q` form body and an honest `deepseek-harness/<version>` user agent — the endpoint's `GET` variant is challenged by DuckDuckGo's anomaly detector. An anomaly page, whether the rate-limit HTTP 202 or a 2xx body carrying the challenge script, surfaces as `WebError` `WEB_PROVIDER_ERROR`, never as an empty result. The remaining failures follow the provider contract: a non-2xx response becomes `WEB_PROVIDER_ERROR` with the HTTP status, a network failure becomes `WEB_PROVIDER_ERROR`, an aborted request becomes `WEB_ABORTED`, and HTTP redirects are rejected before the `Location` target is contacted, surfacing as `WEB_PROVIDER_ERROR`. The request's `maxResults` is enforced by the seam on the way back: the endpoint returns a fixed result page and accepts no count control, and the provider reports `truncated: false`.

## Model Experience

Indirectly, through [`dsh-tool-web`](../tool-web/README.md), which retains this provider's `maxResults`-bounded URLs, titles, and snippets or its exact `DuckDuckGo search aborted`, `DuckDuckGo search request failed: <error>`, `DuckDuckGo API error (HTTP <status>)`, and `DuckDuckGo returned an anomaly challenge page (request rate-limited)` failures under the consumer's error wrapper, while the raw results page and provider-private fields remain outside context.

#### KV Cache effect

No direct invalidation; the named consumer owns any request-prefix changes.

## Known Limitations and Deferred Work

- **Unofficial endpoint** — DuckDuckGo publishes no keyless search API (its public Instant Answer API returns instant answers, not web results), so the HTML endpoint's markup is a deployment detail, not a contract. Markup drift surfaces as missing or zero sources; aggressive rate limiting surfaces as the anomaly-page error. The real-network e2e self-skips where the endpoint answers with a challenge, so markup regressions are caught wherever the endpoint is reachable.
- **No result-count or pagination control** — the endpoint returns one fixed result page and accepts no count parameter; the seam's `maxResults` truncates on the way back. Further pages wait on provider-neutral pagination semantics in the seam.
- **Abort classification is error-shape-based** — only a `DOMException` named `AbortError` maps to `WEB_ABORTED`; an abort carrying a custom reason (e.g. `dsh-timeout`'s `TimeoutReason`) surfaces as `WEB_PROVIDER_ERROR`.
