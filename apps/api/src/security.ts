import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (password: string, salt: Buffer, keylen: number, options: object) => Promise<Buffer>;

/**
 * scrypt from Node's standard library — memory-hard, no native build step, and
 * one less dependency to keep patched than argon2.
 *
 * Parameters follow the OWASP minimum (N=2^17, r=8, p=1). Raising N later is
 * safe: the cost is stored with the hash, so old hashes keep verifying and get
 * upgraded on next sign-in.
 */
const COST = { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEY_LENGTH = 64;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scrypt(password, salt, KEY_LENGTH, COST);
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString("base64")}$${derived.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltPart, hashPart] = stored.split("$");
  if (scheme !== "scrypt") return false;
  try {
    const salt = Buffer.from(saltPart, "base64");
    const expected = Buffer.from(hashPart, "base64");
    const derived = await scrypt(password, salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 256 * 1024 * 1024,
    });
    return derived.length === expected.length && timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

/** True when a stored hash was made with weaker parameters than we now use. */
export function needsRehash(stored: string): boolean {
  const [scheme, n] = stored.split("$");
  return scheme !== "scrypt" || Number(n) < COST.N;
}

/**
 * Opaque tokens for sessions, email links and gateway handshakes.
 *
 * The caller keeps `token` (it goes in a cookie or a URL) and stores only
 * `hash`. A database leak then yields nothing usable.
 */
export function createToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time compare for secrets that arrive as strings (CSRF, API keys). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Turns a display name into a unique-ish handle. The database has the final say
 * via a unique index; callers retry with a new suffix on conflict.
 */
export function handleFrom(name: string): string {
  const base = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]/g, "").slice(0, 15) || "rain";
  return `${base}${randomBytes(2).toString("hex")}`;
}
