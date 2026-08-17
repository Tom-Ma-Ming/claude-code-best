import { mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { getFileDownloadUrl } from './api.js'
import { InboundMsgType } from './types.js'

/** DingTalk's upload categories, keyed off our inbound msgtype vocabulary. */
export type MediaCategory = 'image' | 'voice' | 'video' | 'file'

const EXT_BY_CATEGORY: Record<MediaCategory, string> = {
  image: '.jpg',
  voice: '.amr',
  video: '.mp4',
  file: '',
}

/** Map an inbound `msgtype` to the download category, or null if not media. */
export function categoryForMsgType(msgType: string): MediaCategory | null {
  switch (msgType) {
    case InboundMsgType.PICTURE:
      return 'image'
    case InboundMsgType.AUDIO:
      return 'voice'
    case InboundMsgType.VIDEO:
      return 'video'
    case InboundMsgType.FILE:
      return 'file'
    default:
      return null
  }
}

/** Guess an upload category from a local file's extension. */
export function guessMediaCategory(filePath: string): MediaCategory {
  const ext = extname(filePath).toLowerCase()
  if (['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(ext)) {
    return 'image'
  }
  if (['.amr', '.mp3', '.wav', '.m4a', '.aac'].includes(ext)) return 'voice'
  if (['.mp4', '.mov', '.avi', '.mkv'].includes(ext)) return 'video'
  return 'file'
}

function mediaDir(): string {
  const dir = join(tmpdir(), 'ccb-dingtalk-media')
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Resolve an inbound attachment and write it to a temp file.
 *
 * Returns null rather than throwing: a message whose attachment fails to
 * download should still reach the session as text, not drop the whole turn.
 */
export async function downloadInboundFile(params: {
  token: string
  robotCode: string
  downloadCode: string
  category: MediaCategory
  fileName?: string
  baseUrl?: string
  signal?: AbortSignal
}): Promise<{ path: string; type: string } | null> {
  const {
    token,
    robotCode,
    downloadCode,
    category,
    fileName,
    baseUrl,
    signal,
  } = params

  try {
    const url = await getFileDownloadUrl({
      token,
      robotCode,
      downloadCode,
      baseUrl,
      signal,
    })

    const response = await fetch(url, { signal })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} downloading attachment`)
    }
    const bytes = new Uint8Array(await response.arrayBuffer())

    // Prefer the sender's filename; fall back to a random name so two
    // attachments in one session never collide.
    const safeName = fileName
      ? fileName.replace(/[/\\]/g, '_')
      : `${randomBytes(8).toString('hex')}${EXT_BY_CATEGORY[category]}`

    const path = join(mediaDir(), `${Date.now()}-${safeName}`)
    writeFileSync(path, bytes)
    return { path, type: category }
  } catch (error) {
    process.stderr.write(
      `[dingtalk] Attachment download failed: ${error instanceof Error ? error.message : String(error)}\n`,
    )
    return null
  }
}
