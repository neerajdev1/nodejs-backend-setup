import { createHash } from "node:crypto";

import { env } from "../config/env.js";

/**
 * Redis key convention for this service.
 *
 *   <prefix>:<env>:<namespace>[:<version>]:<entity>[:<id>][:<field>]
 *   payplus:production:cache:v1:user:01H8XK:profile
 *   payplus:production:lock:payout:01H8XK
 *   payplus:production:ratelimit:auth:Nk3mQ...
 *
 * Rules this module enforces, and why:
 *
 * - Colon-delimited, fixed order, most general segment first. That makes every
 *   key greppable by namespace and lets `SCAN MATCH` target one subtree.
 * - Every segment is validated. A colon smuggled in from user input would
 *   silently move a key into another namespace, so an id of `123:admin` is a
 *   rejected input, not a surprise key.
 * - Keys are built here, never concatenated at the call site, so the namespace
 *   layout is changeable in one place.
 * - Untrusted or unbounded values get hashed. Keys show up in `MONITOR`,
 *   `SLOWLOG` and `--bigkeys` output, so a raw email or token in a key leaks it
 *   to anyone with operational access.
 * - The environment is in the key rather than relying on a separate database
 *   index, because `SELECT` does not exist on Redis Cluster and a shared
 *   managed instance is the normal case.
 */

export const KEY_SEPARATOR = ":";

/** `<prefix>:<env>` — the root every key this service owns starts with. */
export const keyRoot = [env.REDIS_KEY_PREFIX, env.NODE_ENV].join(KEY_SEPARATOR);

const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const MAX_SEGMENT_LENGTH = 128;

export class InvalidKeySegmentError extends Error {
  constructor(segment: string, reason: string) {
    super(`Invalid Redis key segment ${JSON.stringify(segment)}: ${reason}`);
    this.name = "InvalidKeySegmentError";
  }
}

const RAW = Symbol("rawKeySegment");

export interface RawKeySegment {
  readonly [RAW]: string;
}

export type KeySegment = string | RawKeySegment;

const isRaw = (segment: KeySegment): segment is RawKeySegment =>
  typeof segment === "object" && segment !== null && RAW in segment;

/**
 * Marks a segment as already safe, for the few values that must contain key
 * syntax: glob wildcards, cluster hash tags, digests. Never hand user input to
 * this directly — hash it instead.
 */
export const rawSegment = (value: string): RawKeySegment => ({ [RAW]: value });

export const assertSegment = (segment: string): string => {
  if (segment.length === 0) {
    throw new InvalidKeySegmentError(segment, "must not be empty");
  }
  if (segment.length > MAX_SEGMENT_LENGTH) {
    throw new InvalidKeySegmentError(
      segment,
      `must be at most ${MAX_SEGMENT_LENGTH} characters`,
    );
  }
  if (!SEGMENT_PATTERN.test(segment)) {
    throw new InvalidKeySegmentError(
      segment,
      "must start alphanumeric and contain only letters, digits, '_', '.' or '-'",
    );
  }
  return segment;
};

export const buildKey = (...segments: KeySegment[]): string =>
  [
    keyRoot,
    ...segments.map((segment) =>
      isRaw(segment) ? segment[RAW] : assertSegment(segment),
    ),
  ].join(KEY_SEPARATOR);

/**
 * Collapses an untrusted or unbounded value into a fixed-width segment. Use for
 * anything user-supplied — emails, tokens, URLs, client-chosen idempotency keys.
 * Truncated SHA-256: 22 base64url characters is ~132 bits, far past collision
 * risk for key-space purposes.
 */
export const hashValue = (value: string, length = 22): string =>
  createHash("sha256").update(value).digest("base64url").slice(0, length);

export const hashSegment = (value: string, length = 22): RawKeySegment =>
  rawSegment(hashValue(value, length));

/**
 * Cluster hash tag. Redis Cluster picks a slot from the CRC16 of the text inside
 * the braces, so keys that must be read or written in one MULTI, pipeline or Lua
 * call have to share a tag or the call fails with CROSSSLOT.
 */
export const hashTag = (value: string): RawKeySegment =>
  rawSegment(`{${assertSegment(value)}}`);

/** Wildcard for `SCAN MATCH`. Only ever use with SCAN — never with KEYS. */
export const WILDCARD = rawSegment("*");

export const NAMESPACE = {
  cache: "cache",
  lock: "lock",
  rateLimit: "ratelimit",
  idempotency: "idem",
  session: "session",
} as const;

/**
 * Cached values. Carries CACHE_SCHEMA_VERSION so bumping that env var retires
 * every cached payload at once — far cheaper and safer than scanning to delete.
 */
export const cacheKey = (...segments: KeySegment[]): string =>
  buildKey(NAMESPACE.cache, env.CACHE_SCHEMA_VERSION, ...segments);

/** `SCAN MATCH` pattern covering a cache subtree, e.g. every field of a user. */
export const cachePattern = (...segments: KeySegment[]): string =>
  cacheKey(...segments, WILDCARD);

export const lockKey = (...segments: KeySegment[]): string =>
  buildKey(NAMESPACE.lock, ...segments);

export const sessionKey = (sessionId: string): string =>
  buildKey(NAMESPACE.session, sessionId);

/** Client-supplied idempotency keys are arbitrary text, so they get hashed. */
export const idempotencyKey = (clientKey: string): string =>
  buildKey(NAMESPACE.idempotency, hashSegment(clientKey));

/**
 * Prefix handed to rate-limit-redis, which appends its own per-client suffix.
 * Trailing separator included so the result stays well-formed.
 */
export const rateLimitPrefix = (bucket: string): string =>
  `${buildKey(NAMESPACE.rateLimit, bucket)}${KEY_SEPARATOR}`;
