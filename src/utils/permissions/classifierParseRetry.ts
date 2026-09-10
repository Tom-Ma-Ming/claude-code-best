import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages.js'
import type { z } from 'zod/v4'
import {
  extractToolUseBlock,
  parseClassifierResponse,
} from './classifierShared.js'

/**
 * How many times to ask the classifier before giving up on a response that
 * carries no usable tool call.
 *
 * The request forces `tool_choice`, so an Anthropic model always answers with
 * the tool. Third-party models behind an Anthropic-compatible gateway do not
 * reliably honour that: MiniMax-M3 answered with plain text in roughly 1 of
 * 12 probes, and the rate climbs with transcript length. A second request is
 * cheap (the prefix is cached) and turns most of those misses into decisions.
 */
export const CLASSIFIER_PARSE_ATTEMPTS = 2

export type ClassifierParseOutcome<T> =
  | { kind: 'ok'; parsed: T; attempts: number }
  | { kind: 'no_tool_use'; attempts: number }
  | { kind: 'invalid_schema'; attempts: number }

/**
 * Call `request` until its content parses as the classifier tool, or
 * attempts run out. The last response is returned alongside the outcome so
 * callers can keep reporting usage and request ids.
 */
export async function requestUntilParsed<
  R extends { content: BetaContentBlock[] },
  S extends z.ZodTypeAny,
>(
  request: () => Promise<R>,
  toolName: string,
  schema: S,
  attempts = CLASSIFIER_PARSE_ATTEMPTS,
): Promise<{ outcome: ClassifierParseOutcome<z.infer<S>>; result: R }> {
  let result!: R
  let outcome: ClassifierParseOutcome<z.infer<S>> = {
    kind: 'no_tool_use',
    attempts: 0,
  }
  for (let attempt = 1; attempt <= attempts; attempt++) {
    result = await request()
    const block = extractToolUseBlock(result.content, toolName)
    if (!block) {
      outcome = { kind: 'no_tool_use', attempts: attempt }
      continue
    }
    const parsed = parseClassifierResponse(block, schema)
    if (parsed === null) {
      outcome = { kind: 'invalid_schema', attempts: attempt }
      continue
    }
    return { outcome: { kind: 'ok', parsed, attempts: attempt }, result }
  }
  return { outcome, result }
}
