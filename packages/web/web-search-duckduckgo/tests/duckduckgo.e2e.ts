import { describe, expect, it } from 'vitest'
import type { WebSearchResult } from '@deepseek-ai/dsh-web'
import { WebError } from '@deepseek-ai/dsh-web'
import { DUCKDUCKGO_DEFAULT_BASE_URL, DuckDuckGoSearchProvider } from '@deepseek-ai/dsh-web-search-duckduckgo'

/**
 * Real-network smoke for the keyless DuckDuckGo HTML endpoint. No credential
 * gates it, so the suite always runs; the test self-skips (not fails) when the
 * endpoint answers with the anti-bot anomaly page, because DuckDuckGo
 * rate-limits datacenter IPs and a challenge is availability, not a provider
 * defect (the same stance as the pwsh suites skipping where PowerShell is
 * absent).
 */
describe('DuckDuckGoSearchProvider real API', () => {
  it('returns http(s) sources for a live query', async (context) => {
    const provider = new DuckDuckGoSearchProvider({
      baseURL: process.env.DDG_BASE_URL ?? DUCKDUCKGO_DEFAULT_BASE_URL,
    })
    let result: WebSearchResult
    try {
      result = await provider.search({ query: 'DeepSeek Harness', maxResults: 5 })
    } catch (error) {
      if (error instanceof WebError && error.code === 'WEB_PROVIDER_ERROR' && error.message.includes('anomaly')) {
        context.skip('DuckDuckGo answered with the anti-bot anomaly page')
      }
      throw error
    }
    expect(result.sources.length).toBeGreaterThan(0)
    for (const source of result.sources) expect(source.url).toMatch(/^https?:\/\//)
  }, 30_000)
})
