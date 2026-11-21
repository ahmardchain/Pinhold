import { codeFromRepo } from "@celo/attribution-tags";
import { describe, expect, it } from "vitest";
import { readTag, resolveAttributionCode, tag } from "../src/attribution.js";
import { transferData } from "../src/chain/wallet.js";
import { parseEmbed } from "../src/telegram/probe.js";

describe("attribution tag", () => {
  const data = transferData("0x2222222222222222222222222222222222222222", 5_000_000n);

  it("appends the code once and keeps the calldata intact", () => {
    const t = tag(data, "celo_abc123");
    expect(t.startsWith(data)).toBe(true);
    expect(readTag(t)).toEqual(["celo_abc123"]);
    expect(tag(t, "celo_abc123")).toBe(t); // idempotent
  });

  it("refuses calldata already tagged by someone else", () => {
    expect(() => tag(tag(data, "celo_other"), "celo_abc123")).toThrow();
  });

  it("requires the issued code to match the repo slug", () => {
    const derived = codeFromRepo("ahmardchain/pinhold");
    expect(resolveAttributionCode(derived, "ahmardchain/Pinhold", "mainnet")).toBe(derived);
    expect(() => resolveAttributionCode("celo_000000000000", "ahmardchain/pinhold", "mainnet")).toThrow();
    expect(() => resolveAttributionCode(undefined, "ahmardchain/pinhold", "mainnet")).toThrow();
    expect(resolveAttributionCode(undefined, "ahmardchain/pinhold", "testnet")).toBe("celo_test1234");
  });
});

describe("public t.me embed check", () => {
  it("reads live, missing and unknown pages", () => {
    expect(parseEmbed('<div class="tgme_widget_message_text js-message_text">Hello</div>')).toBe("ok");
    expect(parseEmbed('<div class="tgme_widget_message_error">Post not found</div>')).toBe("missing");
    expect(parseEmbed("<html>rate limited</html>")).toBe("unknown");
  });
});
