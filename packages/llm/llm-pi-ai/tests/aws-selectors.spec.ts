import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { setBedrockProviderModule } from '@earendil-works/pi-ai/api/bedrock-converse-stream.lazy'
import * as bedrockConverseStream from '@earendil-works/pi-ai/api/bedrock-converse-stream'
import type { Api, Context, Model, SimpleStreamOptions } from '@earendil-works/pi-ai'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { PiAiAdapter } from '../src/adapter.ts'
import type { PiAiAuthInjection } from '../src/adapter.ts'
import { assertServiceable, resolveProfiles } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import { memoryAuth } from './auth-double.ts'

/**
 * The Bedrock implementation pi-ai loads through a variable specifier, which
 * `vi.mock` cannot reach: the installed provider is constructed inside pi-ai's
 * own module, so this test uses pi-ai's own override to observe the AWS SDK
 * boundary keylessly. The override is module-global, hence the restore below.
 */
const streamSimple = vi.fn((..._call: [Model<Api>, Context, SimpleStreamOptions | undefined]): never => {
  throw new Error('mock SDK boundary')
})
setBedrockProviderModule({ stream: streamSimple, streamSimple })

afterEach(() => { streamSimple.mockClear() })
afterAll(() => { setBedrockProviderModule(bedrockConverseStream) })

/** Auth injectables whose ambient context answers with AWS access keys. */
function ambientKeyAuth(): PiAiAuthInjection {
  const base = memoryAuth()
  return {
    credentials: base.credentials,
    authContext: {
      env: name => Promise.resolve(
        name === 'AWS_ACCESS_KEY_ID' || name === 'AWS_SECRET_ACCESS_KEY' ? 'ambient' : undefined,
      ),
      fileExists: () => Promise.resolve(false),
    },
  }
}

/** A Bedrock catalog route narrowed to one model, with the caller's selectors. */
function bedrockAdapter(profile: Record<string, unknown>, auth: PiAiAuthInjection = memoryAuth()): PiAiAdapter {
  return new PiAiAdapter({
    profiles: () => resolveProfiles({
      'amazon-bedrock': { models: [{ id: 'amazon.nova-lite-v1:0' }], ...profile },
    }),
    // What a profile naming no credential reference resolves to: the AWS
    // credential chain is this route's whole authentication.
    resolveApiKey: () => Promise.resolve(undefined),
    auth,
  })
}

async function drain(adapter: PiAiAdapter): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({
    provider: 'amazon-bedrock',
    model: 'amazon.nova-lite-v1:0',
    messages: [],
  })) chunks.push(chunk)
  return chunks
}

describe('AWS route selectors', () => {
  it('authenticates a keyless Bedrock route through the configured profile', async () => {
    const chunks = await drain(bedrockAdapter({ awsProfile: 'sso-prod', awsRegion: 'eu-west-1' }))

    // Reaching the SDK boundary at all is what shows pi-ai's auth resolution
    // accepted the route: the ambient context finds nothing and the credential
    // store is empty, so the request environment is the only AWS answer.
    expect(streamSimple.mock.calls[0]?.[2]).toMatchObject({
      env: { AWS_PROFILE: 'sso-prod', AWS_REGION: 'eu-west-1' },
    })
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'mock SDK boundary' } },
    })
  })

  it('leaves a route naming no selector to answer for itself', async () => {
    const chunks = await drain(bedrockAdapter({}))

    expect(streamSimple).not.toHaveBeenCalled()
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { message: /not configured/ } },
    })
  })

  it('carries a profile alone, leaving the region to the catalog endpoint', async () => {
    await drain(bedrockAdapter({ awsProfile: 'sso-prod' }))

    expect(streamSimple.mock.calls[0]?.[2]?.env).toEqual({ AWS_PROFILE: 'sso-prod' })
  })

  it('carries a region alone beside the ambient credential chain, which holds none', async () => {
    await drain(bedrockAdapter({ awsRegion: 'sa-east-1' }, ambientKeyAuth()))

    expect(streamSimple.mock.calls[0]?.[2]?.env).toEqual({ AWS_REGION: 'sa-east-1' })
  })

  it('refuses a selector nothing on the route would read', () => {
    expect(() => resolveProfiles({
      'acme-gateway': {
        api: 'openai-completions',
        baseURL: 'https://acme.test',
        models: [{ id: 'm' }],
        awsProfile: 'sso-prod',
      },
    })).toThrow(/no model on this route speaks bedrock-converse-stream/)
  })

  it('refuses a profile beside the credential reference that would replace it', () => {
    expect(() => resolveProfiles({
      'amazon-bedrock': { apiKeyEnv: 'AWS_BEARER_TOKEN_BEDROCK', awsProfile: 'sso-prod' },
    })).toThrow(/awsProfile beside apiKeyEnv/)
  })

  it.each([
    ['awsProfile', /has an empty awsProfile/],
    ['awsRegion', /has an empty awsRegion/],
  ] as const)('refuses an empty %s where it is written', (field, message) => {
    const section = { providers: { 'amazon-bedrock': { [field]: '' } } } as unknown as Config
    expect(() => { assertServiceable(section) }).toThrow(message)
  })
})
