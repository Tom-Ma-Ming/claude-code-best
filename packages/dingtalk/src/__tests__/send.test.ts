import { describe, expect, test } from 'bun:test'
import { mediaPayload, splitText } from '../send.js'
import { OutboundMsgKey } from '../types.js'

describe('splitText', () => {
  test('leaves a short message as one chunk', () => {
    expect(splitText('hello')).toEqual(['hello'])
  })

  test('splits on a paragraph break when one is available', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`
    const chunks = splitText(text, 40)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toBe('a'.repeat(30))
    expect(chunks[1]).toBe('b'.repeat(30))
  })

  test('falls back to a line break', () => {
    const text = `${'a'.repeat(30)}\n${'b'.repeat(30)}`
    const chunks = splitText(text, 40)
    expect(chunks[0]).toBe('a'.repeat(30))
    expect(chunks[1]).toBe('b'.repeat(30))
  })

  test('hard-cuts text with no break points', () => {
    const chunks = splitText('a'.repeat(100), 40)
    expect(chunks).toEqual(['a'.repeat(40), 'a'.repeat(40), 'a'.repeat(20)])
  })

  test('never emits a chunk over the limit', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i}`).join('\n')
    for (const chunk of splitText(text, 40)) {
      expect(chunk.length).toBeLessThanOrEqual(40)
    }
  })

  test('preserves the full content across chunks', () => {
    const text = `${'a'.repeat(30)}\n\n${'b'.repeat(30)}`
    expect(splitText(text, 40).join('')).toBe('a'.repeat(30) + 'b'.repeat(30))
  })
})

describe('mediaPayload', () => {
  test('maps an image to photoURL', () => {
    expect(mediaPayload('image', 'media-1', 'a.png')).toEqual({
      msgKey: OutboundMsgKey.IMAGE,
      msgParam: { photoURL: 'media-1' },
    })
  })

  test('maps a video to its media key', () => {
    const { msgKey, msgParam } = mediaPayload('video', 'media-2', 'a.mp4')
    expect(msgKey).toBe(OutboundMsgKey.VIDEO)
    expect(msgParam.videoMediaId).toBe('media-2')
  })

  test('derives fileType from the extension for generic files', () => {
    const { msgKey, msgParam } = mediaPayload('file', 'media-3', 'report.pdf')
    expect(msgKey).toBe(OutboundMsgKey.FILE)
    expect(msgParam).toMatchObject({
      mediaId: 'media-3',
      fileName: 'report.pdf',
      fileType: 'pdf',
    })
  })

  test('falls back to txt when the file has no extension', () => {
    expect(mediaPayload('file', 'm', 'LICENSE').msgParam.fileType).toBe('txt')
  })
})
