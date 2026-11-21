// SQLite storage (node:sqlite, no native build). One file, one process.
// Bigints are stored as decimal strings. The chain is the source of truth for money;
// this database holds bookings, the check timeline, and the tx hashes that link them.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Booking, BookingState, Owner } from "./core/types.js";

export type TxKind = "payment" | "approve" | "swap" | "payout" | "surplus" | "refund";

// `amount` is in the token's own units, except for swaps: a swap records the USD₮ it spent
// in 6-decimal USD units, so the daily cap adds up across chains with different decimals.
export interface TxRecord {
  bookingId: string;
  kind: TxKind;
  hash: string;
  chainId: number;
  token: string;
  amount: bigint;
  to: string;
  dryRun: boolean;
  at: number;
}

export interface TimelineEntry {
  bookingId: string;
  at: number;
  text: string;
}

const BIG = ["priceNgn", "priceUsdt", "cngnPaid", "usdtSpent"] as const;

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, state TEXT NOT NULL, doc TEXT NOT NULL, updated_at INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS bookings_state ON bookings(state);
      CREATE TABLE IF NOT EXISTS owners (id TEXT PRIMARY KEY, channel_id TEXT UNIQUE, telegram_user_id INTEGER, doc TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, at INTEGER NOT NULL, text TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS timeline_booking ON timeline(booking_id);
      CREATE TABLE IF NOT EXISTS txs (id INTEGER PRIMARY KEY AUTOINCREMENT, booking_id TEXT NOT NULL, kind TEXT NOT NULL, hash TEXT NOT NULL,
        chain_id INTEGER NOT NULL, token TEXT NOT NULL, amount TEXT NOT NULL, to_addr TEXT NOT NULL, dry_run INTEGER NOT NULL, at INTEGER NOT NULL,
        UNIQUE(booking_id, kind));
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  // ---------- bookings ----------

  saveBooking(b: Booking): void {
    const doc = JSON.stringify(b, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.db
      .prepare(`INSERT INTO bookings (id, state, doc, updated_at) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET state = excluded.state, doc = excluded.doc, updated_at = excluded.updated_at`)
      .run(b.id, b.state, doc, b.updatedAt);
  }

  getBooking(id: string): Booking | null {
    const row = this.db.prepare("SELECT doc FROM bookings WHERE id = ?").get(id) as { doc: string } | undefined;
    return row ? parseBooking(row.doc) : null;
  }

  listBookings(states?: BookingState[]): Booking[] {
    const rows = states
      ? (this.db.prepare(`SELECT doc FROM bookings WHERE state IN (${states.map(() => "?").join(",")}) ORDER BY updated_at`).all(...states) as { doc: string }[])
      : (this.db.prepare("SELECT doc FROM bookings ORDER BY updated_at").all() as { doc: string }[]);
    return rows.map((r) => parseBooking(r.doc));
  }

  openBookingsForHuman(nullifier: string): number {
    return this.listBookings(["QUOTED", "PAID", "LIVE", "RELEASING", "REFUNDING"]).filter((b) => b.sponsorNullifier === nullifier).length;
  }

  // ---------- owners ----------

  saveOwner(o: Owner): void {
    const doc = JSON.stringify(o, (k, v) => (typeof v === "bigint" ? v.toString() : v));
    this.db
      .prepare(`INSERT INTO owners (id, channel_id, telegram_user_id, doc) VALUES (?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, telegram_user_id = excluded.telegram_user_id, doc = excluded.doc`)
      .run(o.id, o.channelId, o.telegramUserId, doc);
  }

  getOwner(id: string): Owner | null {
    const row = this.db.prepare("SELECT doc FROM owners WHERE id = ?").get(id) as { doc: string } | undefined;
    return row ? parseOwner(row.doc) : null;
  }

  ownerByChannel(channelIdOrUsername: string): Owner | null {
    const key = channelIdOrUsername.replace(/^@/, "").toLowerCase();
    for (const o of this.listOwners()) {
      if (o.channelId === channelIdOrUsername || o.channelUsername?.toLowerCase() === key) return o;
    }
    return null;
  }

  ownersByTelegramUser(userId: number): Owner[] {
    return this.listOwners().filter((o) => o.telegramUserId === userId);
  }

  listOwners(): Owner[] {
    return (this.db.prepare("SELECT doc FROM owners").all() as { doc: string }[]).map((r) => parseOwner(r.doc));
  }

  // ---------- timeline ----------

  log(bookingId: string, at: number, text: string): void {
    this.db.prepare("INSERT INTO timeline (booking_id, at, text) VALUES (?, ?, ?)").run(bookingId, at, text);
  }

  timeline(bookingId: string): TimelineEntry[] {
    return (this.db.prepare("SELECT booking_id, at, text FROM timeline WHERE booking_id = ? ORDER BY id").all(bookingId) as
      { booking_id: string; at: number; text: string }[]).map((r) => ({ bookingId: r.booking_id, at: r.at, text: r.text }));
  }

  // ---------- transactions ----------

  recordTx(t: TxRecord): void {
    this.db
      .prepare(`INSERT INTO txs (booking_id, kind, hash, chain_id, token, amount, to_addr, dry_run, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(booking_id, kind) DO NOTHING`)
      .run(t.bookingId, t.kind, t.hash, t.chainId, t.token, t.amount.toString(), t.to, t.dryRun ? 1 : 0, t.at);
  }

  getTx(bookingId: string, kind: TxKind): TxRecord | null {
    const r = this.db.prepare("SELECT * FROM txs WHERE booking_id = ? AND kind = ?").get(bookingId, kind) as unknown as RawTx | undefined;
    return r ? toTx(r) : null;
  }

  txs(bookingId?: string): TxRecord[] {
    const rows = bookingId
      ? (this.db.prepare("SELECT * FROM txs WHERE booking_id = ? ORDER BY id").all(bookingId) as unknown as RawTx[])
      : (this.db.prepare("SELECT * FROM txs ORDER BY id").all() as unknown as RawTx[]);
    return rows.map(toTx);
  }

  /** USD₮ that left the agent wallet since `since` (swap input + refunds + surplus). */
  outflowSince(since: number): bigint {
    const rows = this.db
      .prepare("SELECT amount FROM txs WHERE kind IN ('swap', 'refund', 'surplus') AND at >= ?")
      .all(since) as { amount: string }[];
    return rows.reduce((s, r) => s + BigInt(r.amount), 0n);
  }

  // ---------- small key/value state (e.g. Telegram update offsets) ----------

  get(k: string): string | null {
    const r = this.db.prepare("SELECT v FROM kv WHERE k = ?").get(k) as { v: string } | undefined;
    return r?.v ?? null;
  }

  set(k: string, v: string): void {
    this.db.prepare("INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").run(k, v);
  }
}

interface RawTx {
  booking_id: string; kind: TxKind; hash: string; chain_id: number; token: string; amount: string; to_addr: string; dry_run: number; at: number;
}

function toTx(r: RawTx): TxRecord {
  return {
    bookingId: r.booking_id, kind: r.kind, hash: r.hash, chainId: r.chain_id, token: r.token,
    amount: BigInt(r.amount), to: r.to_addr, dryRun: r.dry_run === 1, at: r.at,
  };
}

function parseBooking(doc: string): Booking {
  const o = JSON.parse(doc);
  for (const k of BIG) if (o[k] !== null && o[k] !== undefined) o[k] = BigInt(o[k]);
  return o as Booking;
}

function parseOwner(doc: string): Owner {
  const o = JSON.parse(doc);
  o.priceNgn = BigInt(o.priceNgn);
  return o as Owner;
}
