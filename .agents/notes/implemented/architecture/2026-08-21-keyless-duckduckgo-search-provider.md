# Agent Note: Keyless DuckDuckGo search over the unofficial HTML endpoint

Status: implemented

English | [中文](2026-08-21-keyless-duckduckgo-search-provider.zh.md)

## Problem

The web seam's shipped search backends all take deployment-held credentials: DeepSeek official (the shipped default, reusing `DEEPSEEK_API_KEY`), Exa (`EXA_API_KEY`), and Perplexity (its own key). A deployment that wants a working `web_search` without supplying a key has no opt-in choice. DuckDuckGo is the natural keyless provider — it is a major search engine with anonymous search — but it publishes no stable keyless search API: its public Instant Answer API returns instant answers, not web results, and its HTML search endpoint is an unofficial scraping surface.

## Decision

`@deepseek-ai/dsh-web-search-duckduckgo` (`packages/web/web-search-duckduckgo`) registers a keyless `WebSearchProvider` under the id `duckduckgo` with `ctx.web`, in the same function/namespace plugin shape as the other search providers. The package is opt-in: the shipped base composition is unchanged ([the default search decision](../feature/2026-07-31-web-default-search.md) keeps `searchProvider: deepseek-official`), and a deployment selects DuckDuckGo with the provider row plus `searchProvider: duckduckgo` or `$DSH_WEB_SEARCH_PROVIDER=duckduckgo`.

The request path is `POST <baseURL>/html/` (default base `https://html.duckduckgo.com`) with a `q` form body, an honest `deepseek-harness/<version>` user agent, and `redirect: 'error'`. POST is the form that DuckDuckGo's anomaly detector serves: the GET variant of the same endpoint was challenged with an HTTP 202 anomaly page while the POST variant returned results with the same user agent.

The response path parses the page with parse5 through `parse5-htmlparser2-tree-adapter`. Each `div.result` block maps to one source: `a.result__a` supplies `url` and `title`, and the `a`/`span` element carrying the `result__snippet` class supplies `snippet`, with DuckDuckGo's `<b>` query-term wrappers collapsing to plain text. Hrefs in the `duckduckgo.com/l/?uddg=<urlencoded>` redirect form resolve to their decoded target, which may itself be protocol-relative. Blocks without a title anchor, or whose URL cannot be resolved to an absolute http(s) URL, are dropped. The endpoint carries no publication dates and no generated answer, so `publishedAt` is never emitted and `content` is omitted.

The failure vocabulary is the seam's: a non-2xx response becomes `WEB_PROVIDER_ERROR` with the HTTP status, a network failure becomes `WEB_PROVIDER_ERROR`, an abort (a `DOMException` named `AbortError`) becomes `WEB_ABORTED`, and a redirect becomes `WEB_PROVIDER_ERROR` before the `Location` target is contacted. The anti-bot anomaly page is a provider failure, never an empty result: it arrives as HTTP 202 or as a 2xx body referencing the challenge script, and either form maps to `WEB_PROVIDER_ERROR`. A clean 2xx page with zero `div.result` blocks is a genuine zero-hit query and resolves to `sources: []`.

Config is a single key, `baseURL`. The endpoint accepts no result-count parameter and returns one fixed result page, so the request's `maxResults` is enforced by the seam's on-the-way-back truncation and the provider reports `truncated: false`.

## Alternatives considered

**The Instant Answer API.** Rejected: it returns instant answers keyed on the query (abstracts, definitions), not ranked web results; the wrong capability for `web_search`.

**Hand-rolled parsing of the results HTML.** Rejected per the dependency-over-hand-rolling policy: parse5 and its htmlparser2 tree adapter — the same parser stack jsdom uses — delete the owned markup-walking code and its brittle tests for two maintained, zero-dependency packages.

**Mounting the provider in the shipped base composition.** Rejected: opt-ins stay out of shipped defaults, and datacenter-IP deployments (CI, cloud) would meet DuckDuckGo's rate limiting as their default search path.

**Treating the anomaly page as an empty result set.** Rejected: the anomaly page is a challenge, not a zero-hit query; returning `sources: []` for it would silently degrade search under rate limiting.

## Consequences

A keyless `web_search` exists for deployments that want it, selected with a two-line overlay. The provider's closure gains two runtime dependencies (parse5, parse5-htmlparser2-tree-adapter); there is no new credential surface and no environment variable.

Provider quality is bounded by an endpoint whose markup is a deployment detail, not a contract. Markup drift surfaces as missing or zero sources; aggressive rate limiting surfaces as the anomaly-page error; datacenter IPs are challenged more often than residential ones. The real-network e2e self-skips where the endpoint answers with the anomaly page — availability, not a provider defect — so CI stays green on challenged networks and markup regressions are caught wherever the endpoint is reachable.

The provider offers no result-count control and no pagination: the endpoint returns one fixed page. Further pages, and provider-neutral count semantics, wait on pagination decisions in the seam.

## Testing

`tests/duckduckgo.spec.ts` pins the mapping over a captured page fixture (direct hrefs, `uddg` redirect hops, snippetless and anchorless blocks, blank fields), the anomaly/HTTP/abort failure vocabulary, `redirect: 'error'` request options, the `q` form body and honest user agent, and registration through the real `ctx.web` seam (HMR-safe disposal, `WEB_PROVIDER_CONFIGURED_MISSING`/`UNAVAILABLE`, configured and default `baseURL`). `tests/duckduckgo.e2e.ts` is the real-network smoke: it always runs (no key gates it) and self-skips when the endpoint answers with the anomaly page.
