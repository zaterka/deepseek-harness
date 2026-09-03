/**
 * `DuckDuckGoSearchProvider`: a keyless `WebSearchProvider` backed by DuckDuckGo's HTML
 * search endpoint (`POST /html/` with a `q` form body). Each `div.result` block of the
 * page supplies one source: `a.result__a` provides `title` and `url` (a
 * `duckduckgo.com/l/?uddg=` redirect hop is resolved to its target), and the
 * `a`/`span` element carrying the `result__snippet` class provides `snippet`, with
 * DuckDuckGo's query-term `<b>` wrappers collapsing to plain text. The endpoint
 * carries no publication dates and no generated answer, so `publishedAt` is never
 * emitted and `content` is omitted.
 * @module @deepseek-ai/dsh-web-search-duckduckgo/provider
 */

import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import { parseFragment } from 'parse5'
import { adapter } from 'parse5-htmlparser2-tree-adapter'

/** Stable id this provider registers under. */
export const DUCKDUCKGO_PROVIDER_ID = 'duckduckgo'

/** Default DuckDuckGo HTML search endpoint; `/html/` is the operation. */
export const DUCKDUCKGO_DEFAULT_BASE_URL = 'https://html.duckduckgo.com'

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.1.1-rc.2'

/** Substring identifying DuckDuckGo's anti-bot challenge page inside a 2xx body. */
const ANOMALY_MARKER = 'anomaly.js'

/** Class token of the element that opens one result block. */
const RESULT_BLOCK_CLASS = 'result'

/** Class token of the anchor that carries a result's title and target URL. */
const RESULT_TITLE_CLASS = 'result__a'

/** Class token of the element that carries a result's snippet. */
const RESULT_SNIPPET_CLASS = 'result__snippet'

/** Resolved provider options (the plugin's `apply` supplies the constant default). */
export interface DuckDuckGoSearchProviderOptions {
  /** Endpoint base; `/html/` is appended. */
  baseURL: string
}

/**
 * A tag node of the domhandler tree that `parse5-htmlparser2-tree-adapter`
 * produces. The `type` literals mirror domelementtype's `ElementType` values
 * (a TS enum, which is why the fragment is read through this structural view
 * at the parse boundary).
 */
interface HtmlElementNode {
  readonly type: 'tag'
  readonly name: string
  readonly attribs: Record<string, string>
  readonly children: readonly HtmlNode[]
}

/** A text node of the domhandler tree. */
interface HtmlTextNode {
  readonly type: 'text'
  readonly data: string
}

/** Any non-element, non-text node of the tree (comment, CDATA, processing
 * instruction, or document): it carries no result data. The kinds mirror
 * domhandler's `ChildNode` union, the adapter's node set. */
interface HtmlOpaqueNode {
  readonly type: 'comment' | 'cdata' | 'pi' | 'root'
}

/**
 * One node of the domhandler tree, viewed structurally: the adapter's own node
 * types are a superset of these arms, so the parsed fragment is read through
 * this view.
 */
type HtmlNode = HtmlElementNode | HtmlTextNode | HtmlOpaqueNode

/**
 * Parse a DuckDuckGo results page into normalized sources.
 *
 * Each `div` whose class list contains the `result` token is a result block: its
 * `a.result__a` supplies `title` and `url`, and its `result__snippet` element
 * (anchor or span) supplies `snippet`. A block whose title anchor is missing or
 * whose URL cannot be resolved to an absolute http(s) URL is dropped; a clean
 * page with no result blocks yields an empty source list (a genuine zero-hit
 * query), never an error.
 *
 * @param html - the raw 2xx HTML body of `POST /html/`.
 * @returns the normalized sources in page order.
 */
export function parseDuckDuckGoResults(html: string): readonly WebSearchSource[] {
  const root = parseFragment(html, { treeAdapter: adapter })
  // domelementtype's string-enum `ElementType` is not assignable to the plain
  // literals of the structural view below; the values are identical, so the
  // single parse boundary bridges the nominal enum once.
  const rootNodes = adapter.getChildNodes(root) as unknown as readonly HtmlNode[]
  const sources: WebSearchSource[] = []
  for (const node of rootNodes) collectResultBlocks(node, sources)
  return sources
}

/**
 * Resolve a `result__a` href to the absolute URL of the page it cites.
 *
 * DuckDuckGo serves two href forms: a direct absolute (or protocol-relative)
 * URL, and a redirect hop of the form
 * `https://duckduckgo.com/l/?uddg=<urlencoded target>`. Hops are resolved to
 * their decoded target, which may itself be protocol-relative. A bare
 * `duckduckgo.com` link without a `uddg` target, or a value that is not an
 * absolute URL even after decoding, yields `undefined` (no citable source).
 *
 * @param href - the raw `href` attribute of `a.result__a`.
 * @returns the absolute http(s) URL of the cited page, or `undefined`.
 */
export function resolveResultUrl(href: string | undefined): string | undefined {
  if (href === undefined || href.length === 0) return undefined
  const candidate = href.startsWith('//') ? `https:${href}` : href
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return undefined
  }
  if (url.hostname === 'duckduckgo.com' || url.hostname.endsWith('.duckduckgo.com')) {
    const target = url.searchParams.get('uddg')
    if (target === null) return undefined
    try {
      return new URL(target.startsWith('//') ? `https:${target}` : target).toString()
    } catch {
      return undefined
    }
  }
  return url.toString()
}

/**
 * Map one result block to a source, or `undefined` when it has no
 * `a.result__a` anchor or that anchor's URL cannot be resolved to an absolute
 * http(s) URL (a result without a citable URL is noise).
 *
 * @param block - the `div.result` element.
 * @returns the normalized source (title and snippet are omitted when absent or
 *   blank — the seam carries sources without them), or `undefined`.
 */
function mapResultBlock(block: HtmlElementNode): WebSearchSource | undefined {
  const titleAnchor = firstElementByClass(block, RESULT_TITLE_CLASS, 'a')
  if (titleAnchor === undefined) return undefined
  const url = resolveResultUrl(titleAnchor.attribs['href'])
  if (url === undefined) return undefined
  const title = normalizeText(textOf(titleAnchor))
  const snippetNode = firstElementByClass(block, RESULT_SNIPPET_CLASS)
  const snippet = snippetNode === undefined ? '' : normalizeText(textOf(snippetNode))
  return {
    url,
    ...title.length > 0 ? { title } : {},
    ...snippet.length > 0 ? { snippet } : {},
  }
}

/** Collect the result blocks under `node` (depth-first) into `sources`. */
function collectResultBlocks(node: HtmlNode, sources: WebSearchSource[]): void {
  if (node.type !== 'tag') return
  if (node.name === 'div' && hasClass(node, RESULT_BLOCK_CLASS)) {
    const source = mapResultBlock(node)
    if (source !== undefined) sources.push(source)
    return
  }
  for (const child of node.children) collectResultBlocks(child, sources)
}

/** Depth-first search for the first element carrying class token `cls`. */
function firstElementByClass(node: HtmlNode, cls: string, tag?: string): HtmlElementNode | undefined {
  if (node.type === 'tag') {
    if (tag === undefined || node.name === tag) {
      if (hasClass(node, cls)) return node
    }
    for (const child of node.children) {
      const match = firstElementByClass(child, cls, tag)
      if (match !== undefined) return match
    }
  }
  return undefined
}

/** True when the element's `class` attribute lists `cls` as a whitespace-separated token. */
function hasClass(node: { attribs: Record<string, string> }, cls: string): boolean {
  return (node.attribs['class'] ?? '').split(/\s+/).includes(cls)
}

/** All descendant text of `node` (markup such as `<b>` query terms drops out). */
function textOf(node: HtmlNode): string {
  if (node.type === 'text') return node.data
  if (node.type !== 'tag') return ''
  return node.children.map(textOf).join('')
}

/** Collapse whitespace runs and trim; the seam consumes single-line snippet text. */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * The DuckDuckGo-backed search provider. `POST /html/` rejects redirects before
 * their `Location` target is contacted (they surface as `WEB_PROVIDER_ERROR`);
 * the anti-bot anomaly page — HTTP 202, or a 200 body carrying the challenge
 * script — is a provider failure, never an empty result set.
 */
export class DuckDuckGoSearchProvider implements WebSearchProvider {
  readonly id = DUCKDUCKGO_PROVIDER_ID

  constructor(private readonly options: DuckDuckGoSearchProviderOptions) {}

  available(): boolean {
    return isValidBaseUrl(this.options.baseURL)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    let response: Response
    try {
      response = await fetch(`${this.options.baseURL}/html/`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'accept': 'text/html',
          'user-agent': USER_AGENT,
        },
        body: `q=${encodeURIComponent(request.query)}`,
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      throw new WebError(`DuckDuckGo API error (HTTP ${response.status})`, 'WEB_PROVIDER_ERROR')
    }

    let html: string
    try {
      html = await response.text()
    } catch (error: unknown) {
      // An abort firing mid-body must surface as WEB_ABORTED, not be swallowed
      // into a provider error (the seam's cancellation contract).
      if (isAbortError(error)) throw new WebError('DuckDuckGo search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`DuckDuckGo search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (html.includes(ANOMALY_MARKER)) {
      throw new WebError('DuckDuckGo returned an anomaly challenge page (request rate-limited)', 'WEB_PROVIDER_ERROR')
    }

    // The endpoint emits no generated answer, so `content` is omitted. The web
    // service owns the final `maxResults` truncation, so this provider reports
    // `truncated: false`.
    return { sources: parseDuckDuckGoResults(html), truncated: false }
  }
}

/** True when `baseURL` parses as an absolute URL (a cheap local config check). */
function isValidBaseUrl(baseURL: string): boolean {
  return URL.canParse(baseURL)
}

/** True for a fetch/`AbortSignal` abort, surfaced as `WEB_ABORTED`. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}
