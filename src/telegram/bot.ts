// Telegram bot (grammY) for channel owners.
//  - Onboarding: the owner adds the bot to the channel as an admin (no rights needed),
//    then /register @channel <payout wallet> <price in naira> <hold hours>.
//    Pinhold checks the owner is a real admin of that channel, then asks them to verify
//    once with Self: a Self Agent ID whose NFT is owned by the payout wallet.
//  - Posts: channel_post and edited_channel_post updates feed the state machine.
//  - Notifications to owners and to Pinhold's operator.

import { requestRegistration } from "@selfxyz/agent-sdk";
import { Bot, type Context } from "grammy";
import { isAddress } from "viem";
import { textMatches } from "../core/match.js";
import type { Address, Booking, Owner } from "../core/types.js";
import type { Store } from "../db.js";
import type { Engine, Notifier } from "../engine.js";

export const ONBOARDING_TEXT = `Pinhold holds a sponsor's payment until their ad has stayed up in your channel for the agreed time, then pays you in naira (cNGN).

Setup, once:
1. Add @{bot} to your channel as an admin. Turn every permission off; it only needs to see posts.
2. Send me: /register @yourchannel 0xYourWallet 5000 24
   (your channel, the wallet that receives cNGN, your price in naira, and how many hours the post must stay up)
3. Verify with the Self app when I send you the link (one passport scan, nothing personal is shared).

Then sponsors book through Pinhold. When a booking is paid I send you the exact text. Post it unchanged and leave it up for the hold window. You get paid automatically. If the post is deleted or edited early, the sponsor is refunded instead.

Use a wallet that shows cNGN (for example Valora).`;

export interface BotDeps {
  token: string;
  store: Store;
  engine: () => Engine;
  selfNetwork: "mainnet" | "testnet";
  adminChatId?: string;
  publicBaseUrl: string;
  now: () => number;
  log: (line: string) => void;
}

export function buildBot(d: BotDeps) {
  const bot = new Bot(d.token);
  const { store } = d;

  bot.command(["start", "help"], async (ctx) => {
    const me = await ctx.api.getMe();
    await ctx.reply(ONBOARDING_TEXT.replace("{bot}", me.username));
  });

  bot.command("register", async (ctx) => {
    const args = (ctx.match ?? "").trim().split(/\s+/);
    if (args.length < 4) {
      return ctx.reply("Usage: /register @yourchannel 0xYourWallet <price in naira> <hold hours>\nExample: /register @mychannel 0x1234…abcd 5000 24");
    }
    const [channelArg, wallet, priceArg, hoursArg] = args;
    if (!isAddress(wallet)) return ctx.reply("That wallet address is not valid. It should start with 0x and have 42 characters.");
    const price = Number(priceArg.replace(/[,₦]/g, ""));
    const hours = Number(hoursArg);
    // Testnet: Textile's sandbox corridor is only a few hundred naira deep.
    const minPrice = d.selfNetwork === "testnet" ? 100 : 1000;
    if (!Number.isFinite(price) || price < minPrice || price > 1_000_000) {
      return ctx.reply(`Price must be between ₦${minPrice.toLocaleString("en-US")} and ₦1,000,000.`);
    }
    if (!Number.isInteger(hours) || hours < 1 || hours > 168) return ctx.reply("Hold hours must be a whole number from 1 to 168.");

    let chat;
    try {
      chat = await ctx.api.getChat(channelArg.startsWith("@") || channelArg.startsWith("-") ? channelArg : `@${channelArg}`);
    } catch {
      return ctx.reply("I can't see that channel. Add me as an admin first, then try again.");
    }
    if (chat.type !== "channel") return ctx.reply("That is not a channel.");
    const me = await ctx.api.getMe();
    const [botMember, userMember] = await Promise.all([
      ctx.api.getChatMember(chat.id, me.id).catch(() => null),
      ctx.api.getChatMember(chat.id, ctx.from!.id).catch(() => null),
    ]);
    if (botMember?.status !== "administrator") return ctx.reply("Please add me to the channel as an admin (no permissions needed), then send /register again.");
    if (!userMember || (userMember.status !== "creator" && userMember.status !== "administrator")) {
      return ctx.reply("Only an admin of that channel can register it.");
    }

    const owner: Owner = {
      id: `own_${String(chat.id).replace("-", "m")}`,
      telegramUserId: ctx.from!.id,
      channelId: String(chat.id),
      channelUsername: "username" in chat && chat.username ? chat.username : null,
      channelTitle: chat.title,
      payoutWallet: wallet as Address,
      selfAgentId: null, // set only after the Self proof lands on chain
      priceNgn: BigInt(Math.round(price)) * 1_000_000n,
      holdHours: hours,
      createdAt: d.now(),
    };
    const existing = store.getOwner(owner.id);
    const sameWallet = existing && existing.payoutWallet.toLowerCase() === owner.payoutWallet.toLowerCase();
    store.saveOwner({ ...owner, selfAgentId: sameWallet ? existing!.selfAgentId : null });
    if (sameWallet && existing!.selfAgentId) {
      return ctx.reply(`Updated ${chat.title}: ₦${price.toLocaleString("en-US")} for ${hours} h. Your Self verification is still valid.`);
    }

    // Self Agent ID, linked mode: the payout wallet owns the agent NFT. Pinhold checks that
    // binding on chain before every payout, so only this verified wallet can ever be paid.
    try {
      const session = await requestRegistration({ mode: "linked", network: d.selfNetwork, humanAddress: wallet });
      await ctx.reply(`Last step: verify with Self. Open this link on your phone with the Self app installed:\n${session.deepLink}\n\nOr scan the QR code: ${session.scanUrl}\n\nThe link expires in about 30 minutes.`);
      void session.waitForCompletion().then(async ({ agentId }) => {
        const o = store.getOwner(owner.id);
        if (!o || o.payoutWallet.toLowerCase() !== wallet.toLowerCase()) return;
        store.saveOwner({ ...o, selfAgentId: String(agentId) });
        await bot.api.sendMessage(ctx.from!.id, `Verified. ${chat.title} is now listed on Pinhold (Self Agent ID #${agentId}).`);
        d.log(`Owner ${o.id} verified with Self agent ${agentId}`);
      }).catch(async (e) => {
        await bot.api.sendMessage(ctx.from!.id, `Self verification did not complete (${(e as Error).message}). Send /register again to get a new link.`);
      });
    } catch (e) {
      d.log(`Self registration start failed: ${(e as Error).message}`);
      await ctx.reply("Self verification is unavailable right now. Please try /register again in a few minutes.");
    }
  });

  bot.command("status", async (ctx) => {
    const owners = store.ownersByTelegramUser(ctx.from!.id);
    if (!owners.length) return ctx.reply("You have no channels on Pinhold yet. Send /start to begin.");
    const lines: string[] = [];
    for (const o of owners) {
      lines.push(`${o.channelTitle}: ₦${(Number(o.priceNgn) / 1e6).toLocaleString("en-US")} / ${o.holdHours} h, ${o.selfAgentId ? `verified (Self #${o.selfAgentId})` : "NOT verified yet"}`);
      for (const b of store.listBookings(["PAID", "LIVE", "RELEASING", "REFUNDING"]).filter((x) => x.ownerId === o.id)) {
        lines.push(`  ${b.id}: ${b.state} ${d.publicBaseUrl}/r/${b.id}`);
      }
    }
    await ctx.reply(lines.join("\n"));
  });

  // Bot added to a channel: tell the person who added it what to do next.
  bot.on("my_chat_member", async (ctx) => {
    const u = ctx.myChatMember;
    if (u.chat.type !== "channel" || u.new_chat_member.status !== "administrator") return;
    const handle = "username" in u.chat && u.chat.username ? `@${u.chat.username}` : String(u.chat.id);
    await ctx.api.sendMessage(u.from.id, `I'm now an admin of ${u.chat.title}. Next: /register ${handle} 0xYourWallet <price in naira> <hold hours>`).catch(() => undefined);
  });

  const postText = (ctx: Context) => {
    const p = ctx.channelPost ?? ctx.editedChannelPost;
    return p ? (p.text ?? p.caption ?? "") : "";
  };

  bot.on("channel_post", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const text = postText(ctx);
    for (const b of store.listBookings(["PAID"]).filter((x) => x.channelId === chatId)) {
      if (textMatches(b.postText, text)) {
        await d.engine().apply(b.id, { type: "POST_SEEN", messageId: ctx.channelPost!.message_id, text });
        break; // one post fulfils one booking
      }
    }
  });

  bot.on("edited_channel_post", async (ctx) => {
    const chatId = String(ctx.chat.id);
    const id = ctx.editedChannelPost!.message_id;
    for (const b of store.listBookings(["LIVE"]).filter((x) => x.channelId === chatId && x.messageId === id)) {
      await d.engine().apply(b.id, { type: "POST_EDITED", messageId: id, text: postText(ctx) });
    }
  });

  bot.catch((e) => d.log(`telegram error: ${e.message}`));
  return bot;
}

export class TelegramNotifier implements Notifier {
  constructor(private readonly bot: Bot, private readonly store: Store, private readonly publicBaseUrl: string, private readonly adminChatId?: string) {}

  async notify(b: Booking, to: "owner" | "sponsor", text: string): Promise<void> {
    const link = `${this.publicBaseUrl}/r/${b.id}`;
    if (to === "owner") {
      const o = this.store.getOwner(b.ownerId);
      if (!o) return;
      const body = b.state === "PAID"
        ? `${text}\n\nPost exactly this (copy it as is):\n\n${b.postText}\n\nPost by ${new Date(b.postDeadline).toUTCString()}. Keep it up for ${b.holdHours} h.\nReceipt: ${link}`
        : `${text}\nReceipt: ${link}`;
      await this.bot.api.sendMessage(o.telegramUserId, body, { link_preview_options: { is_disabled: true } });
    } else if (this.adminChatId) {
      // Sponsors are agents: they follow the receipt URL. The operator gets a copy.
      await this.bot.api.sendMessage(this.adminChatId, `[sponsor] ${text} ${link}`);
    }
  }
}

export class ConsoleNotifier implements Notifier {
  constructor(private readonly log: (line: string) => void) {}
  async notify(b: Booking, to: "owner" | "sponsor", text: string) {
    this.log(`notify ${to}: ${text}`);
  }
}
