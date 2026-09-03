import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  DUCKDUCKGO_DEFAULT_BASE_URL,
  DUCKDUCKGO_PROVIDER_ID,
  DuckDuckGoSearchProvider,
} from '@deepseek-ai/dsh-web-search-duckduckgo'
import * as ddgPlugin from '@deepseek-ai/dsh-web-search-duckduckgo'
import { parseDuckDuckGoResults, resolveResultUrl } from '../src/provider.ts'

const options = { baseURL: 'https://html.duckduckgo.test' }

function htmlResponse(html: string, init: ResponseInit = {}): Response {
  return new Response(html, { status: 200, headers: { 'content-type': 'text/html' }, ...init })
}

/** Captured-shaped DuckDuckGo results page: six blocks exercising every mapping branch. */
const RESULTS_HTML = `<!DOCTYPE html>
<html>
  <body>
    <div id="center">
      <div class="results">
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="https://www.deepseek.com/harness/en/">DeepSeek Harness developer preview</a>
            </h2>
            <a class="result__snippet" href="https://www.deepseek.com/harness/en/"><b>DeepSeek</b> <b>Harness</b> is<!-- term --> now in developer preview</a>
          </div>
        </div>
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1&amp;rut=abc123">Redirected result title</a>
            </h2>
            <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1&amp;rut=abc123"><b>Redirected</b> snippet text with a newline
and   extra spaces.</a>
          </div>
        </div>
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="https://nosnippet.test/">Snippet-less title</a>
            </h2>
            <em>classless marker</em>
          </div>
        </div>
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="relative/path.html">Relative href</a>
            </h2>
          </div>
        </div>
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">
              <a rel="nofollow" class="result__a" href="https://urlonly.test/"></a>
            </h2>
            <a class="result__snippet" href="https://urlonly.test/">   </a>
          </div>
        </div>
        <div class="result results_links results_links_deep web-result ">
          <div class="links_main links_deep result__body">
            <h2 class="result__title">no anchor here</h2>
          </div>
        </div>
      </div>
    </div>
  </body>
</html>`

const EXPECTED_SOURCES = [
  {
    url: 'https://www.deepseek.com/harness/en/',
    title: 'DeepSeek Harness developer preview',
    snippet: 'DeepSeek Harness is now in developer preview',
  },
  {
    url: 'https://example.com/page?x=1',
    title: 'Redirected result title',
    snippet: 'Redirected snippet text with a newline and extra spaces.',
  },
  { url: 'https://nosnippet.test/', title: 'Snippet-less title' },
  { url: 'https://urlonly.test/' },
]

/** DuckDuckGo's rate-limit challenge page (served as HTTP 202 or a 200 body). */
const ANOMALY_HTML = '<html><head><script src="/anomaly.js"></script></head><body><form id="challenge-form" action="//duckduckgo.com/anomaly.js?u=abc"></form></body></html>'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseDuckDuckGoResults', () => {
  it('maps result blocks: titles, uddg-resolved URLs, snippets, and blank-field omission', () => {
    expect(parseDuckDuckGoResults(RESULTS_HTML)).toEqual(EXPECTED_SOURCES)
  })

  it('drops blocks with no title anchor or no resolvable URL', () => {
    const html = '<div class="result"><h2 class="result__title">no anchor</h2></div>'
      + '<div class="result"><a class="result__a" href="relative/x">bad href</a></div>'
    expect(parseDuckDuckGoResults(html)).toEqual([])
  })

  it('reads a span snippet element as well as an anchor snippet', () => {
    const html = '<div class="result"><a class="result__a" href="https://span.test/">T</a>'
      + '<span class="result__snippet">span <b>bold</b> text</span></div>'
    expect(parseDuckDuckGoResults(html)).toEqual([{ url: 'https://span.test/', title: 'T', snippet: 'span bold text' }])
  })

  it('returns an empty source list for a clean page with no result blocks', () => {
    expect(parseDuckDuckGoResults('<html><body><div class="results"></div></body></html>')).toEqual([])
  })
})

describe('resolveResultUrl', () => {
  it('passes direct absolute URLs through, normalized by the URL constructor', () => {
    expect(resolveResultUrl('https://example.com/page')).toBe('https://example.com/page')
  })

  it('resolves protocol-relative direct URLs over https', () => {
    expect(resolveResultUrl('//example.com/page')).toBe('https://example.com/page')
  })

  it('resolves uddg redirect hops to their decoded target', () => {
    expect(resolveResultUrl('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage%3Fx%3D1&rut=abc'))
      .toBe('https://example.com/page?x=1')
  })

  it('resolves uddg targets that are themselves protocol-relative', () => {
    expect(resolveResultUrl('https://duckduckgo.com/l/?uddg=%2F%2Fexample.com%2Fx')).toBe('https://example.com/x')
  })

  it('accepts subdomain redirect hosts', () => {
    expect(resolveResultUrl('https://external-content.duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F'))
      .toBe('https://example.com/')
  })

  it('rejects bare duckduckgo.com links without a uddg target', () => {
    expect(resolveResultUrl('https://duckduckgo.com/about')).toBeUndefined()
    expect(resolveResultUrl('//duckduckgo.com/home')).toBeUndefined()
  })

  it('rejects empty, relative, and malformed values', () => {
    expect(resolveResultUrl(undefined)).toBeUndefined()
    expect(resolveResultUrl('')).toBeUndefined()
    expect(resolveResultUrl('relative/path')).toBeUndefined()
    expect(resolveResultUrl('https://duckduckgo.com/l/?uddg=not a url')).toBeUndefined()
  })
})

describe('DuckDuckGoSearchProvider availability', () => {
  it('is available with a parseable base URL', () => {
    expect(new DuckDuckGoSearchProvider(options).available()).toBe(true)
  })

  it('is unavailable when the base URL is unparseable', () => {
    expect(new DuckDuckGoSearchProvider({ baseURL: 'not a url' }).available()).toBe(false)
  })
})

describe('DuckDuckGoSearchProvider request mapping', () => {
  it('POSTs the urlencoded query to <baseURL>/html/ with attribution headers', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(RESULTS_HTML))
    vi.stubGlobal('fetch', fetchMock)
    await new DuckDuckGoSearchProvider(options).search({ query: 'DeepSeek Harness' })
    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://html.duckduckgo.test/html/')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init.body).toBe('q=DeepSeek%20Harness')
    const headers = init.headers as Record<string, string>
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(headers['accept']).toBe('text/html')
    expect(headers['user-agent']).toBe('deepseek-harness/0.1.1-rc.2')
  })

  it('forwards the abort signal', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(RESULTS_HTML))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await new DuckDuckGoSearchProvider(options).search({ query: 'q' }, controller.signal)
    expect((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].signal).toBe(controller.signal)
  })

  it('returns the parsed sources and reports truncated: false', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(RESULTS_HTML)))
    const result = await new DuckDuckGoSearchProvider(options).search({ query: 'q' })
    expect(result).toEqual({ sources: EXPECTED_SOURCES, truncated: false })
    expect(result.content).toBeUndefined()
  })
})

describe('DuckDuckGoSearchProvider failures', () => {
  it('maps non-2xx responses to WEB_PROVIDER_ERROR with the HTTP status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('', { status: 404 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DuckDuckGo API error (HTTP 404)', code: 'WEB_PROVIDER_ERROR' }))
    vi.unstubAllGlobals()
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('', { status: 500 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DuckDuckGo API error (HTTP 500)', code: 'WEB_PROVIDER_ERROR' }))
  })

  it('maps a 202 anomaly response to WEB_PROVIDER_ERROR (the challenge is a failure, not an empty result)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ANOMALY_HTML, { status: 202 })))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        message: 'DuckDuckGo returned an anomaly challenge page (request rate-limited)',
        code: 'WEB_PROVIDER_ERROR',
      }))
  })

  it('maps a network failure to WEB_PROVIDER_ERROR with the cause', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connection refused') }))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        message: 'DuckDuckGo search request failed: TypeError: connection refused',
        code: 'WEB_PROVIDER_ERROR',
      }))
  })

  it('maps a fetch abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('aborted', 'AbortError') }))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DuckDuckGo search aborted', code: 'WEB_ABORTED' }))
  })

  it('maps a mid-body abort to WEB_ABORTED', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    }) as unknown as Response))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ message: 'DuckDuckGo search aborted', code: 'WEB_ABORTED' }))
  })

  it('maps a mid-body read failure to WEB_PROVIDER_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      status: 200,
      text: () => Promise.reject(new TypeError('body closed')),
    }) as unknown as Response))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        message: 'DuckDuckGo search request failed: TypeError: body closed',
        code: 'WEB_PROVIDER_ERROR',
      }))
  })

  it('maps a 200 anomaly challenge page to WEB_PROVIDER_ERROR, not an empty result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(ANOMALY_HTML)))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({
        message: 'DuckDuckGo returned an anomaly challenge page (request rate-limited)',
        code: 'WEB_PROVIDER_ERROR',
      }))
  })

  it('returns an empty result set for a clean 200 page with zero result blocks', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse('<html><body><div class="results"></div></body></html>')))
    await expect(new DuckDuckGoSearchProvider(options).search({ query: 'q' }))
      .resolves.toEqual({ sources: [], truncated: false })
  })
})

describe('web-search-duckduckgo plugin registration', () => {
  it('registers the provider into ctx.web (HMR-safe)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => htmlResponse(RESULTS_HTML)))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, {})
    const result = await ctx.web.search({ query: 'q' })
    expect(result.sources).toHaveLength(4)
    expect(result.truncated).toBe(false)
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_MISSING' }))
  })

  it('has no default export (namespace plugin export shape)', () => {
    expect('default' in ddgPlugin).toBe(false)
  })

  it('threads the configured baseURL into the request URL', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(RESULTS_HTML))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, { baseURL: 'https://html.duckduckgo.test' })
    await ctx.web.search({ query: 'q' })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe('https://html.duckduckgo.test/html/')
    await fiber.dispose()
  })

  it('uses the default base URL when the config omits baseURL', async () => {
    const fetchMock = vi.fn(async () => htmlResponse(RESULTS_HTML))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    const fiber = await ctx.plugin(ddgPlugin, {})
    await ctx.web.search({ query: 'q' })
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe(`${DUCKDUCKGO_DEFAULT_BASE_URL}/html/`)
    await fiber.dispose()
  })

  it('is unavailable when the configured baseURL is unparseable', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: DUCKDUCKGO_PROVIDER_ID })
    await ctx.plugin(ddgPlugin, { baseURL: 'not a url' })
    await expect(ctx.web.search({ query: 'q' }))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_CONFIGURED_UNAVAILABLE' }))
  })
})
