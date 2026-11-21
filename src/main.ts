// Pinhold agent: API + Telegram bot + worker in one process.

import type { Hex } from "viem";
import { resolveAttributionCode } from "./attribution.js";
import { SelfIdentity } from "./chain/self.js";
import { FixedRateFx, TAKER_CONTROL_TYPES, takerControlDomain, TextileClient, type FxProvider } from "./chain/textile.js";
import { makeWallet } from "./chain/wallet.js";
import { describeConfig, loadConfig } from "./config.js";
import { Store } from "./db.js";
import { Engine, type Notifier } from "./engine.js";
import { Executor } from "./executor.js";
import { buildServer } from "./server.js";
import { buildBot, ConsoleNotifier, TelegramNotifier } from "./telegram/bot.js";
import { type PostProbe, ScriptedProbe, TelegramProbe } from "./telegram/probe.js";
import { Worker } from "./worker.js";

const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);
const now = () => Date.now();

const cfg = loadConfig();
const code = resolveAttributionCode(cfg.ATTRIBUTION_CODE, cfg.GITHUB_REPO, cfg.net.name);
log(`Pinhold starting: ${describeConfig(cfg)} tag=${code}`);

const store = new Store(cfg.DATABASE_PATH);
const key = cfg.AGENT_PRIVATE_KEY as Hex | undefined;
const payWallet = makeWallet({ profile: cfg.net.pay, privateKey: key, attributionCode: code, dryRun: cfg.DRY_RUN, log });
const fxWallet = cfg.net.fx.chainId === cfg.net.pay.chainId
  ? payWallet
  : makeWallet({ profile: cfg.net.fx, privateKey: key, attributionCode: code, dryRun: cfg.DRY_RUN, log });

const fx: FxProvider = cfg.DRY_RUN
  ? new FixedRateFx(cfg.DRY_RUN_NGN_PER_USD, "0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3")
  : new TextileClient({
      apiBase: cfg.net.fx.textileApi,
      chainId: cfg.net.fx.chainId,
      sellToken: cfg.net.fx.stable.address,
      sellDecimals: cfg.net.fx.stable.decimals,
      buyToken: cfg.net.fx.cngn.address,
      apiKey: cfg.TEXTILE_API_KEY,
      signTakerProof: (message) => fxWallet.signTypedData({
        domain: takerControlDomain(cfg.net.fx.chainId),
        types: TAKER_CONTROL_TYPES,
        primaryType: "TakerControl",
        message,
      } as never),
    });

const identity = new SelfIdentity({ network: cfg.net.self.network, registry: cfg.net.self.registry, rpcUrl: cfg.net.pay.rpcUrl });

let probe: PostProbe;
let notifier: Notifier;
let engineRef: Engine | null = null;
let bot: ReturnType<typeof buildBot> | null = null;

if (cfg.TELEGRAM_BOT_TOKEN) {
  if (!cfg.TELEGRAM_LOG_CHAT_ID) throw new Error("TELEGRAM_LOG_CHAT_ID is required with a bot token (post existence checks)");
  bot = buildBot({
    token: cfg.TELEGRAM_BOT_TOKEN, store, engine: () => engineRef!, selfNetwork: cfg.net.self.network,
    adminChatId: cfg.TELEGRAM_ADMIN_CHAT_ID, publicBaseUrl: cfg.PUBLIC_BASE_URL, now, log,
  });
  probe = new TelegramProbe(bot.api, cfg.TELEGRAM_LOG_CHAT_ID);
  notifier = new TelegramNotifier(bot, store, cfg.PUBLIC_BASE_URL, cfg.TELEGRAM_ADMIN_CHAT_ID);
} else {
  log("No TELEGRAM_BOT_TOKEN: Telegram is off; post checks are scripted (dry run only)");
  if (!cfg.DRY_RUN) throw new Error("TELEGRAM_BOT_TOKEN is required unless DRY_RUN=true");
  probe = new ScriptedProbe();
  notifier = new ConsoleNotifier(log);
}

const executor = new Executor({
  store, net: cfg.net, payWallet, fxWallet, fx, identity, channels: probe,
  dailyCap: cfg.DAILY_CAP_USDT, surplusMinReturn: cfg.SURPLUS_MIN_RETURN_USDT, now, log,
});
const engine = new Engine(store, executor, notifier, now, log);
engineRef = engine;

const app = buildServer({ cfg, store, engine, identity, fx, payTo: payWallet.address, now, log });
app.listen(cfg.PORT, () => log(`API on :${cfg.PORT} (payTo ${payWallet.address})`));

new Worker(store, engine, probe, cfg.CHECK_INTERVAL_MINUTES * 60_000, now, log).start();

if (bot) {
  void bot.start({
    allowed_updates: ["message", "channel_post", "edited_channel_post", "my_chat_member"],
    onStart: (me) => log(`Telegram bot @${me.username} polling`),
  });
}

const shutdown = () => {
  log("shutting down");
  void bot?.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
