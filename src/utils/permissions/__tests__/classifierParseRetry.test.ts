import { describe, expect, test } from 'bun:test'
import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages.js'
import { z } from 'zod/v4'
import {
  CLASSIFIER_PARSE_ATTEMPTS,
  requestUntilParsed,
} from '../classifierParseRetry.js'

const schema = z.object({ shouldBlock: z.boolean(), reason: z.string() })
const toolUse = (input: unknown) => ({
  content: [{ type: 'tool_use', id: 't1', name: 'classify_result', input }],
})
const textOnly = { content: [{ type: 'text', text: 'Allowed.' }] }

type Resp = { content: BetaContentBlock[] }
function sequence(responses: unknown[]) {
  let calls = 0
  return {
    request: async (): Promise<Resp> =>
      responses[Math.min(calls++, responses.length - 1)] as Resp,
    calls: () => calls,
  }
}

describe('requestUntilParsed', () => {
  test('returns the decision on the first good response', async () => {
    const seq = sequence([toolUse({ shouldBlock: false, reason: 'tests' })])
    const { outcome } = await requestUntilParsed(
      seq.request,
      'classify_result',
      schema,
    )
    expect(outcome).toEqual({
      kind: 'ok',
      parsed: { shouldBlock: false, reason: 'tests' },
      attempts: 1,
    })
    expect(seq.calls()).toBe(1)
  })

  test('retries once when the model ignored tool_choice and answered in text', async () => {
    const seq = sequence([
      textOnly,
      toolUse({ shouldBlock: true, reason: 'rm -rf' }),
    ])
    const { outcome, result } = await requestUntilParsed(
      seq.request,
      'classify_result',
      schema,
    )
    expect(outcome.kind).toBe('ok')
    expect(outcome.attempts).toBe(2)
    expect(result.content[0]?.type).toBe('tool_use')
  })

  test('gives up after the attempt budget and reports no_tool_use', async () => {
    const seq = sequence([textOnly])
    const { outcome } = await requestUntilParsed(
      seq.request,
      'classify_result',
      schema,
    )
    expect(outcome).toEqual({
      kind: 'no_tool_use',
      attempts: CLASSIFIER_PARSE_ATTEMPTS,
    })
    expect(seq.calls()).toBe(CLASSIFIER_PARSE_ATTEMPTS)
  })

  test('a tool call with the wrong shape is invalid_schema, and is retried too', async () => {
    const seq = sequence([
      toolUse({ shouldBlock: 'yes' }),
      toolUse({ shouldBlock: 'yes' }),
    ])
    const { outcome } = await requestUntilParsed(
      seq.request,
      'classify_result',
      schema,
    )
    expect(outcome).toEqual({ kind: 'invalid_schema', attempts: 2 })
  })

  test('a tool call under a different name does not count', async () => {
    const seq = sequence([
      { content: [{ type: 'tool_use', id: 'x', name: 'other', input: {} }] },
    ])
    const { outcome } = await requestUntilParsed(
      seq.request,
      'classify_result',
      schema,
      1,
    )
    expect(outcome).toEqual({ kind: 'no_tool_use', attempts: 1 })
  })
})
