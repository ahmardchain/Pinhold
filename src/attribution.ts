// ERC-8021 attribution. Every transaction Pinhold sends ends with this suffix.
// The Loops-issued code is derived from the GitHub repo slug; if they ever disagree,
// Pinhold refuses to start rather than send transactions that credit nobody.

import { codeFromRepo, fromDataSuffix, toDataSuffix } from "@celo/attribution-tags";
import { concat, type Hex } from "viem";

export const DEV_CODE = "celo_test1234";

export function resolveAttributionCode(issued: string | undefined, repo: string, network: "mainnet" | "testnet"): string {
  const derived = codeFromRepo(repo);
  if (issued) {
    if (issued !== derived) {
      throw new Error(`ATTRIBUTION_CODE ${issued} does not match codeFromRepo("${repo}") = ${derived}`);
    }
    return issued;
  }
  if (network === "mainnet") throw new Error("No attribution code on mainnet");
  return DEV_CODE;
}

export function attributionSuffix(code: string): Hex {
  return toDataSuffix(code) as Hex;
}

/** Append the tag to calldata. Never appends twice: an existing tag must already carry our code. */
export function tag(data: Hex, code: string): Hex {
  const existing = fromDataSuffix(data);
  if (existing) {
    if (!existing.codes.includes(code)) throw new Error(`Calldata already tagged with ${existing.codes.join(",")}`);
    return data;
  }
  return concat([data, attributionSuffix(code)]);
}

export function readTag(data: Hex): string[] {
  return fromDataSuffix(data)?.codes ?? [];
}
