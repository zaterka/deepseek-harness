/** Decode helpers for the pipeline settings section: total-read defaulting for malformed wire data. */
import { describe, expect, it } from 'vitest'
import {
  decodeDevModePipelineSection, emptyDevModePipelineSection,
} from '../src/pipeline-copy.ts'

describe('emptyDevModePipelineSection', () => {
  it('produces an empty role and context for every field', () => {
    expect(emptyDevModePipelineSection()).toEqual({
      planReview: { provider: '', model: '' },
      implement: { provider: '', model: '' },
      codeReview: { provider: '', model: '' },
      context: { planner: '', planReview: '', implement: '', codeReview: '' },
    })
  })
})

describe('decodeDevModePipelineSection', () => {
  it('defaults a non-object section entirely', () => {
    expect(decodeDevModePipelineSection(undefined)).toEqual(emptyDevModePipelineSection())
    expect(decodeDevModePipelineSection(null)).toEqual(emptyDevModePipelineSection())
    expect(decodeDevModePipelineSection('nope')).toEqual(emptyDevModePipelineSection())
    expect(decodeDevModePipelineSection([])).toEqual(emptyDevModePipelineSection())
  })

  it('decodes a well-formed section verbatim', () => {
    const section = {
      planReview: { provider: 'acme', model: 'acme-large' },
      implement: { provider: 'acme', model: 'acme-small' },
      codeReview: { provider: 'other', model: 'other-model' },
      context: { planner: 'p', planReview: 'r', implement: 'i', codeReview: 'c' },
    }
    expect(decodeDevModePipelineSection(section)).toEqual(section)
  })

  it('defaults a malformed role to empty while keeping sibling roles', () => {
    expect(decodeDevModePipelineSection({
      planReview: 'not an object',
      implement: { provider: 'acme', model: 42 },
      codeReview: { provider: 7 },
    })).toEqual({
      planReview: { provider: '', model: '' },
      implement: { provider: 'acme', model: '' },
      codeReview: { provider: '', model: '' },
      context: { planner: '', planReview: '', implement: '', codeReview: '' },
    })
  })

  it('defaults a missing or malformed context object to empty strings', () => {
    expect(decodeDevModePipelineSection({})).toEqual(emptyDevModePipelineSection())
    expect(decodeDevModePipelineSection({ context: 'not an object' })).toEqual(emptyDevModePipelineSection())
    expect(decodeDevModePipelineSection({ context: { planner: 123, implement: 'kept' } })).toEqual({
      ...emptyDevModePipelineSection(),
      context: { planner: '', planReview: '', implement: 'kept', codeReview: '' },
    })
  })
})
