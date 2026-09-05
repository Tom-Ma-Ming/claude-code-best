import {
  ConversationType,
  loadAccount,
  loadChannelConfig,
  sendMarkdown,
} from '@claude-code-best/dingtalk'
import type { Notifier } from '../ports.js'

/**
 * Posts through the machine's own DingTalk app (the one `ccb dingtalk login`
 * stored). The conversation defaults to the bound one so a coordinator that
 * already talks to its team group needs no extra setting.
 *
 * Mentions: the proactive robot API has no `at` field for markdown, so staff
 * ids are written into the text as `@staffId`, which DingTalk renders as a
 * mention for enterprise robots. Verify against the real group once — see
 * docs/features/devflow.md.
 */
export class DingtalkNotifier implements Notifier {
  constructor(
    private readonly options: { profile?: string; conversationId?: string },
  ) {}

  async announce(params: {
    title: string
    text: string
    atUserIds?: string[]
  }): Promise<void> {
    const account = loadAccount(this.options.profile)
    if (!account) {
      throw new Error(
        `No DingTalk credentials${this.options.profile ? ` for profile ${this.options.profile}` : ''}. Run \`ccb dingtalk login\`.`,
      )
    }
    const conversationId =
      this.options.conversationId ??
      loadChannelConfig(this.options.profile).boundConversationId
    if (!conversationId) {
      throw new Error(
        'No DingTalk conversation to announce in. Set devflow.dingtalk.conversationId or run `ccb dingtalk bind`.',
      )
    }
    const mentions = (params.atUserIds ?? []).map(id => `@${id}`).join(' ')
    await sendMarkdown({
      account,
      target: {
        chatId: conversationId,
        conversationType: ConversationType.GROUP,
        atUserId: params.atUserIds?.[0],
      },
      title: params.title,
      text: mentions ? `${mentions}\n\n${params.text}` : params.text,
    })
  }
}

/** Prints instead of sending — for dry runs and machines without DingTalk. */
export class ConsoleNotifier implements Notifier {
  async announce(params: {
    title: string
    text: string
    atUserIds?: string[]
  }): Promise<void> {
    process.stdout.write(
      `[devflow notify] ${params.title}\n${(params.atUserIds ?? []).map(id => `@${id}`).join(' ')}\n${params.text}\n`,
    )
  }
}
