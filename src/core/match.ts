// Deterministic post-text matching. No AI: the booked text and the live text must be
// equal after normalization. Normalization only removes differences Telegram itself
// introduces (Unicode forms, whitespace, invisible characters), never wording.

const INVISIBLE = /[​-‍⁠﻿­]/g;

export function normalizePostText(text: string): string {
  return text
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t ]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function textMatches(booked: string, live: string): boolean {
  return normalizePostText(booked) === normalizePostText(live);
}

/** Similarity 0..1 (Dice coefficient over bigrams). Shown on receipts as a diagnostic only. */
export function similarity(a: string, b: string): number {
  const x = normalizePostText(a);
  const y = normalizePostText(b);
  if (x === y) return 1;
  if (x.length < 2 || y.length < 2) return 0;
  const grams = new Map<string, number>();
  for (let i = 0; i < x.length - 1; i++) {
    const g = x.slice(i, i + 2);
    grams.set(g, (grams.get(g) ?? 0) + 1);
  }
  let hits = 0;
  for (let i = 0; i < y.length - 1; i++) {
    const g = y.slice(i, i + 2);
    const n = grams.get(g) ?? 0;
    if (n > 0) {
      grams.set(g, n - 1);
      hits++;
    }
  }
  return (2 * hits) / (x.length - 1 + (y.length - 1));
}
