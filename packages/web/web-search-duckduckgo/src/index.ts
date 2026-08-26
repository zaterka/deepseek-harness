/**
 * `@deepseek-ai/dsh-web-search-duckduckgo`: registers a keyless DuckDuckGo-backed
 * `WebSearchProvider` with `ctx.web`. A function/namespace plugin (NOT a
 * default-export service): a search provider does not own the `ctx.web` key — it
 * registers INTO the seam's provider registry, exactly as
 * `@deepseek-ai/dsh-web-search-exa` registers one. The key is owned by
 * `@deepseek-ai/dsh-web`.
 *
 * @module @deepseek-ai/dsh-web-search-duckduckgo
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { DuckDuckGoSearchProvider, DUCKDUCKGO_DEFAULT_BASE_URL } from './provider.ts'

export {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
  parseDuckDuckGoResults,
  resolveResultUrl,
} from './provider.ts'
export type { DuckDuckGoSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-duckduckgo'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills the constant default). */
export interface Config {
  /** Endpoint base; `/html/` is appended. Defaults to the public HTML search endpoint. */
  baseURL?: string
}

export const Config: z<Config> = z.object({
  baseURL: z.string(),
})

/** Register the DuckDuckGo search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new DuckDuckGoSearchProvider({
    baseURL: config.baseURL ?? DUCKDUCKGO_DEFAULT_BASE_URL,
  }))
}
