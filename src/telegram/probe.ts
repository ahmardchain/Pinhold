// Is the post still up? Two independent checks, documented in README "Limitations".
//
// 1. Bot check (authoritative, works for public and private channels): copy the post into a
//    private log chat, then delete the copy. Telegram answers "message to copy not found"
//    when the post is gone. Bots get no deletion events, so this is how deletion is seen.
// 2. Public check (public channels only, no bot needed): t.me/<channel>/<id>?embed=1 renders
//    the post or an error widget. Used when the bot check cannot answer (e.g. the channel
//    restricts copying, or Telegram is briefly unreachable).
//
// Edits arrive as `edited_channel_post` updates in real time (see bot.ts).

import type { Api } from "grammy";
import type { Booking, Owner } from "../core/types.js";
import type { ChannelProbe } from "../executor.js";

export type Existence = "ok" | "missing" | "unknown";

export interface PostProbe extends ChannelProbe {
  postExists(b: Booking): Promise<Existence>;
}

export function parseEmbed(html: string): Existence {
  if (/tgme_widget_message_error|Post not found|Channel with username .* not found/i.test(html)) return "missing";
  if (/tgme_widget_message_(text|photo|video|document|bubble)/.test(html)) return "ok";
  return "unknown";
}

export async function publicEmbedCheck(username: string, messageId: number, fetchImpl: typeof fetch = fetch): Promise<Existence> {
  try {
    const res = await fetchImpl(`https://t.me/${encodeURIComponent(username)}/${messageId}?embed=1&mode=tme`, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; PinholdBot/1.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return "unknown";
    return parseEmbed(await res.text());
  } catch {
    return "unknown";
  }
}

export class TelegramProbe implements PostProbe {
  constructor(private readonly api: Api, private readonly logChatId: string) {}

  async isChannelAdmin(owner: Owner): Promise<boolean> {
    try {
      const m = await this.api.getChatMember(owner.channelId, owner.telegramUserId);
      return m.status === "creator" || m.status === "administrator";
    } catch {
      return false;
    }
  }

  async postExists(b: Booking): Promise<Existence> {
    if (b.messageId === null) return "unknown";
    let bot: Existence = "unknown";
    try {
      const copy = await this.api.copyMessage(this.logChatId, b.channelId, b.messageId, { disable_notification: true });
      bot = "ok";
      await this.api.deleteMessage(this.logChatId, copy.message_id).catch(() => undefined);
    } catch (e) {
      const msg = String((e as Error).message ?? e);
      if (/message to copy not found|message not found|MESSAGE_ID_INVALID/i.test(msg)) bot = "missing";
      // "message can't be copied" (protected content), rate limits, network: unknown
    }
    if (bot !== "unknown") return bot;
    return b.channelUsername ? publicEmbedCheck(b.channelUsername, b.messageId) : "unknown";
  }
}

/** Dry-run probe: the demo script decides what exists. */
export class ScriptedProbe implements PostProbe {
  readonly deleted = new Set<string>();
  admins = true;

  async isChannelAdmin(): Promise<boolean> {
    return this.admins;
  }

  async postExists(b: Booking): Promise<Existence> {
    return this.deleted.has(b.id) ? "missing" : "ok";
  }
}
