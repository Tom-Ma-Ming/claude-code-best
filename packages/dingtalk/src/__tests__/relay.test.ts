import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  beginRun,
  formatRelay,
  isChannelEcho,
  lastAssistantText,
  relayCategory,
  shouldSendProgress,
} from '../relay.js'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccb-relay-'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function transcript(lines: unknown[]): string {
  const path = join(dir, 'transcript.jsonl')
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n'))
  return path
}

describe('relayCategory', () => {
  test.each([
    ['UserPromptSubmit', 'prompts'],
    ['Stop', 'replies'],
    ['PreToolUse', 'toolCalls'],
    ['PostToolUse', 'toolCalls'],
    ['PostToolUseFailure', 'toolCalls'],
    ['StopFailure', 'errors'],
    ['SessionEnd', 'session'],
    ['SessionStart', 'session'],
  ])('%s maps to %s', (event, category) => {
    expect(relayCategory(event)).toBe(category as never)
  })

  test('unknown events are not relayed', () => {
    expect(relayCategory('PreCompact')).toBeNull()
  })
})

describe('lastAssistantText', () => {
  test('returns the final assistant message', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'first' }],
        },
      },
      { type: 'user', message: { role: 'user', content: 'hi' } },
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'second' }],
        },
      },
    ])
    expect(lastAssistantText(path)).toBe('second')
  })

  test('joins multiple text blocks in one message', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'a' },
            { type: 'tool_use', id: 'x' },
            { type: 'text', text: 'b' },
          ],
        },
      },
    ])
    expect(lastAssistantText(path)).toBe('a\nb')
  })

  test('handles string content', () => {
    const path = transcript([
      { type: 'assistant', message: { role: 'assistant', content: 'plain' } },
    ])
    expect(lastAssistantText(path)).toBe('plain')
  })

  test('skips malformed lines rather than throwing', () => {
    const path = join(dir, 't.jsonl')
    writeFileSync(
      path,
      'not json\n' +
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'ok' }],
          },
        }),
    )
    expect(lastAssistantText(path)).toBe('ok')
  })

  test('returns null for a missing file', () => {
    expect(lastAssistantText(join(dir, 'nope.jsonl'))).toBeNull()
  })

  test('returns null when there is no assistant text', () => {
    const path = transcript([
      { type: 'user', message: { role: 'user', content: 'hi' } },
    ])
    expect(lastAssistantText(path)).toBeNull()
  })
})

describe('formatRelay', () => {
  test('renders a prompt', () => {
    const out = formatRelay({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'run tests',
    })
    expect(out?.markdown).toBe(true)
    expect(out?.text).toContain('run tests')
  })

  test('skips an empty prompt', () => {
    expect(
      formatRelay({ hook_event_name: 'UserPromptSubmit', prompt: '   ' }),
    ).toBeNull()
  })

  test('renders the reply read from the transcript', () => {
    const path = transcript([
      {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'done' }],
        },
      },
    ])
    expect(
      formatRelay({ hook_event_name: 'Stop', transcript_path: path })?.text,
    ).toContain('done')
  })

  test('skips Stop when the transcript yields nothing', () => {
    expect(formatRelay({ hook_event_name: 'Stop' })).toBeNull()
  })

  test('a tool call renders nothing without progress context', () => {
    // PreToolUse only speaks when shouldSendProgress() let it through; without
    // that context there is no run duration to report.
    const out = formatRelay({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'bun test' },
    })
    expect(out?.text).not.toContain('bun test')
    expect(out?.text).not.toContain('Bash')
  })

  test('stays quiet on successful tool completion', () => {
    expect(
      formatRelay({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }),
    ).toBeNull()
  })

  test.each([
    [{ is_timeout: true }, 'timed out'],
    [{ is_interrupt: true }, 'interrupted'],
    [{ error_type: 'ENOENT' }, 'ENOENT'],
  ])('labels a tool failure %o', (extra, expected) => {
    const out = formatRelay({
      hook_event_name: 'PostToolUseFailure',
      tool_name: 'Bash',
      error: 'boom',
      ...extra,
    })
    expect(out?.text).toContain(expected)
  })

  test('renders a turn that died on an API error', () => {
    expect(
      formatRelay({ hook_event_name: 'StopFailure', error: 'rate_limit' })
        ?.text,
    ).toContain('rate_limit')
  })

  test('renders session end', () => {
    expect(
      formatRelay({ hook_event_name: 'SessionEnd', reason: 'clear' })?.text,
    ).toContain('clear')
  })
})

describe('progress note', () => {
  const AFTER = 20_000
  const start = {
    runSession: 's1',
    runStartedAt: 1_000,
    progressSent: false,
    toolCount: 0,
  }

  test('stays silent while the run is still young', () => {
    const r = shouldSendProgress({
      sessionId: 's1',
      now: 5_000,
      state: start,
      progressAfterMs: AFTER,
    })
    expect(r.send).toBe(false)
  })

  test('fires once the run outlives the threshold', () => {
    const r = shouldSendProgress({
      sessionId: 's1',
      now: 30_000,
      state: start,
      progressAfterMs: AFTER,
    })
    expect(r.send).toBe(true)
    expect(r.send && r.elapsedMs).toBe(29_000)
  })

  test('fires at most once per run', () => {
    const first = shouldSendProgress({
      sessionId: 's1',
      now: 30_000,
      state: start,
      progressAfterMs: AFTER,
    })
    const second = shouldSendProgress({
      sessionId: 's1',
      now: 60_000,
      state: first.state,
      progressAfterMs: AFTER,
    })
    expect(second.send).toBe(false)
  })

  test('a new run resets the clock and the once-only flag', () => {
    const done = shouldSendProgress({
      sessionId: 's1',
      now: 30_000,
      state: start,
      progressAfterMs: AFTER,
    }).state
    const fresh = beginRun('s1', 100_000)
    const r = shouldSendProgress({
      sessionId: 's1',
      now: 105_000,
      state: fresh,
      progressAfterMs: AFTER,
    })
    expect(done.progressSent).toBe(true)
    expect(r.send).toBe(false)
  })

  test('a different session starts its own run', () => {
    const r = shouldSendProgress({
      sessionId: 's2',
      now: 30_000,
      state: start,
      progressAfterMs: AFTER,
    })
    expect(r.send).toBe(false)
    expect(r.state.runSession).toBe('s2')
  })

  test('counts the tools seen in the run', () => {
    let st = beginRun('s1', 0)
    for (const t of [1_000, 2_000, 3_000]) {
      st = shouldSendProgress({
        sessionId: 's1',
        now: t,
        state: st,
        progressAfterMs: AFTER,
      }).state
    }
    const out = shouldSendProgress({
      sessionId: 's1',
      now: 30_000,
      state: st,
      progressAfterMs: AFTER,
    })
    expect(out.send && out.toolCount).toBe(4)
  })

  test('progressAfterMs of 0 disables it entirely', () => {
    const r = shouldSendProgress({
      sessionId: 's1',
      now: 999_999,
      state: start,
      progressAfterMs: 0,
    })
    expect(r.send).toBe(false)
  })
})

describe('progress rendering', () => {
  test('reports elapsed time and tool count, never the command', () => {
    const out = formatRelay(
      {
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'deploy --token=abc' },
      },
      { elapsedMs: 45_000, toolCount: 12 },
    )
    expect(out?.text).toContain('45s')
    expect(out?.text).toContain('12')
    expect(out?.text).not.toContain('token')
    expect(out?.text).not.toContain('Bash')
  })
})

describe('isChannelEcho', () => {
  test('detects a message injected by this channel', () => {
    expect(
      isChannelEcho(
        '<channel source="plugin:dingtalk:dingtalk" chat_id="c" sender_id="s">\nhello\n</channel>',
      ),
    ).toBe(true)
  })

  test('detects it regardless of attribute order', () => {
    expect(
      isChannelEcho(
        '<channel chat_id="c" source="plugin:dingtalk:dingtalk">hi</channel>',
      ),
    ).toBe(true)
  })

  test('leaves another channel alone', () => {
    expect(
      isChannelEcho(
        '<channel source="plugin:weixin:weixin" chat_id="c">hi</channel>',
      ),
    ).toBe(false)
  })

  test('leaves ordinary terminal input alone', () => {
    expect(isChannelEcho('run the tests')).toBe(false)
    expect(isChannelEcho('explain <channel> tags in XML')).toBe(false)
  })
})

describe('formatRelay echo suppression', () => {
  test('does not mirror a prompt that came from DingTalk', () => {
    expect(
      formatRelay({
        hook_event_name: 'UserPromptSubmit',
        prompt:
          '<channel source="plugin:dingtalk:dingtalk" chat_id="c">deploy</channel>',
      }),
    ).toBeNull()
  })

  test('still mirrors a prompt typed in the terminal', () => {
    expect(
      formatRelay({ hook_event_name: 'UserPromptSubmit', prompt: 'deploy' }),
    ).not.toBeNull()
  })
})
