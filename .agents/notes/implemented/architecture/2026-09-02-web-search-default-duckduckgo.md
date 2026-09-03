# Agent Note: DuckDuckGo becomes the shipped-default web search

Status: implemented

English | [中文](2026-09-02-web-search-default-duckduckgo.zh.md)

## Problem

The shipped base composition ([`packages/bundle/base/cordis.patch.yml`](../../../packages/bundle/base/cordis.patch.yml)) defaulted `searchProvider` to `deepseek-official`, so every shipped surface (Web GUI, headless, CLI, Python SDK) needed a `DEEPSEEK_API_KEY` to run `web_search`. The [keyless DuckDuckGo provider](../architecture/2026-08-21-keyless-duckduckgo-search-provider.md) made anonymous search available, but only as an opt-in overlay. A fresh installation that ran `web_search` without a search key hit a credential-missing failure on its default path instead of returning results.

## Decision

`packages/bundle/base/cordis.patch.yml` selects `searchProvider: duckduckgo` and mounts the `@deepseek-ai/dsh-web-search-duckduckgo` row. The base bundle therefore ships DuckDuckGo as the default search engine across every profile that inherits the base layer. This supersedes the default-search selection recorded in [the original shipped-search decision](../feature/2026-07-31-web-default-search.md) (which chose `deepseek-official`) and reverses the "do not mount the provider in the shipped base composition" rejection recorded in [the keyless DDG provider note](../architecture/2026-08-21-keyless-duckduckgo-search-provider.md).

DeepSeek search stays mounted alongside DuckDuckGo and remains selectable, so a deployment that prefers official retrieval (or needs the credential-based endpoint) sets `searchProvider: deepseek-official`, equivalents to the `$DSH_WEB_SEARCH_PROVIDER` environment variable, or a profile overlay. The `@deepseek-ai/dsh-web-search-deepseek` dependency stays in the base bundle; DuckDuckGo's is added alongside it. Replacing the default does not remove DeepSeek search from the shipped install or from publication.

The tradeoff accepted by shipping an unofficial, keyless, HTML-scraping endpoint as the default: the markup is a deployment detail rather than a contract, and DuckDuckGo rate-limits datacenter-IP deployments (CI, cloud) more aggressively than residential ones. Those deployments were the reason the keyless provider was originally kept out of the shipped default. A rate-limited deployment now sees the anomaly-page `WebError` (`WEB_PROVIDER_ERROR`) on its default path and should select `deepseek-official`. The failure is structured, never a silent empty result set.

## Alternatives considered

**Keep `deepseek-official` as the default and leave DuckDuckGo opt-in.** Rejected: it preserves the requirement that a keyless `web_search` work out of the box, which is the point of shipping a keyless provider.

**Remove DeepSeek search from the base bundle.** Rejected: DeepSeek search remains a first-class provider for deployments that supply the key, and removing it would force those deployments to add a non-default row and dependency.

## Consequences

A fresh installation's `web_search` works with no search credential, and the running Web GUI inherits the base default through its patch layers. DeepSeek search and the existing `deepseek-official` selection stay available for credential-backed deployments. The base bundle carries both search providers, which follows the precedent that the bundle ships the providers behind its selectable defaults. Datacenter/CI deployments that meet DuckDuckGo rate limiting select `deepseek-official` in their overlay.

## Testing

The base bundle test validates the patch file parses and mounts its rows; the keyless DDG provider's unit and real-network e2e suites (mapping, failure vocabulary, HMR-safe registration) cover the provider itself. Selection of `duckduckgo` in the base patch is the load-time default; no snapshot asserts the previous default, so the change is exercised by the bundle test and the provider suites, with the working real-network query verified separately.
