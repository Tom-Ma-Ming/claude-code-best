import { describe, expect, test } from 'bun:test'
import { buildAck, handleFrame, parseFrame } from '../stream.js'
import { ROBOT_MESSAGE_TOPIC, StreamFrameType } from '../types.js'
import type { StreamAck, StreamFrame } from '../types.js'

function frame(overrides: Partial<StreamFrame> = {}): StreamFrame {
  return {
    type: StreamFrameType.CALLBACK,
    headers: { messageId: 'msg-1', topic: ROBOT_MESSAGE_TOPIC },
    data: '{}',
    ...overrides,
  }
}

function collector() {
  const acks: StreamAck[] = []
  const messages: unknown[] = []
  let disconnected = false
  return {
    acks,
    messages,
    get disconnected() {
      return disconnected
    },
    handlers: {
      onMessage: async (payload: unknown) => {
        messages.push(payload)
      },
      send: (ack: StreamAck) => {
        acks.push(ack)
      },
      onDisconnect: () => {
        disconnected = true
      },
    },
  }
}

describe('parseFrame', () => {
  test('parses a JSON string frame', () => {
    const parsed = parseFrame(
      JSON.stringify({
        type: 'CALLBACK',
        headers: { messageId: 'm1', topic: ROBOT_MESSAGE_TOPIC },
        data: '{}',
      }),
    )
    expect(parsed?.headers.messageId).toBe('m1')
  })

  test('parses a Buffer frame', () => {
    const raw = Buffer.from(
      JSON.stringify({
        type: 'SYSTEM',
        headers: { messageId: 'm2', topic: 'ping' },
        data: '{}',
      }),
    )
    expect(parseFrame(raw)?.headers.topic).toBe('ping')
  })

  test('returns null on malformed JSON', () => {
    expect(parseFrame('not json')).toBeNull()
  })

  test('returns null when messageId is missing', () => {
    expect(
      parseFrame(JSON.stringify({ type: 'SYSTEM', headers: {} })),
    ).toBeNull()
  })
})

describe('buildAck', () => {
  test('produces a 200 ack carrying the messageId', () => {
    const ack = buildAck('abc')
    expect(ack.code).toBe(200)
    expect(ack.headers.messageId).toBe('abc')
    expect(JSON.parse(ack.data)).toEqual({ status: 'SUCCESS' })
  })
})

describe('handleFrame', () => {
  test('echoes the payload back on a ping', async () => {
    const c = collector()
    await handleFrame(
      frame({
        type: StreamFrameType.SYSTEM,
        headers: { messageId: 'p1', topic: 'ping' },
        data: JSON.stringify({ now: 123 }),
      }),
      c.handlers,
    )
    expect(c.acks).toHaveLength(1)
    expect(JSON.parse(c.acks[0]!.data)).toEqual({ now: 123 })
    expect(c.messages).toHaveLength(0)
  })

  test('signals a reconnect on a disconnect frame without acking', async () => {
    const c = collector()
    await handleFrame(
      frame({
        type: StreamFrameType.SYSTEM,
        headers: { messageId: 'd1', topic: 'disconnect' },
      }),
      c.handlers,
    )
    expect(c.disconnected).toBe(true)
    expect(c.acks).toHaveLength(0)
  })

  test('delivers robot messages and acks them', async () => {
    const c = collector()
    await handleFrame(
      frame({ data: JSON.stringify({ msgId: 'x', text: { content: 'hi' } }) }),
      c.handlers,
    )
    expect(c.acks).toHaveLength(1)
    expect(c.messages).toEqual([{ msgId: 'x', text: { content: 'hi' } }])
  })

  test('acks before invoking the handler so a slow turn is not redelivered', async () => {
    const order: string[] = []
    await handleFrame(frame(), {
      onMessage: async () => {
        order.push('handler')
      },
      send: () => {
        order.push('ack')
      },
      onDisconnect: () => {},
    })
    expect(order).toEqual(['ack', 'handler'])
  })

  test('acks unknown topics without dispatching them', async () => {
    const c = collector()
    await handleFrame(
      frame({ headers: { messageId: 'u1', topic: '/v1.0/some/other' } }),
      c.handlers,
    )
    expect(c.acks).toHaveLength(1)
    expect(c.messages).toHaveLength(0)
  })

  test('tolerates a malformed data payload', async () => {
    const c = collector()
    await handleFrame(frame({ data: '<<<not json>>>' }), c.handlers)
    expect(c.messages).toEqual([{}])
  })
})
