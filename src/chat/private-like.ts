import type { AdapterConfig, ChatMessage } from './types.js';

const NEGATIVE_TTL_MS = 10 * 60_000;
const negativeCache = new Map<string, number>();

export type CompleteMemberProof =
  | { complete: true; nonAgentUserIds: string[] }
  | { complete: true; privateLike: false }
  | { complete: false };

function cacheKey(adapter: AdapterConfig, message: Pick<ChatMessage, 'chatId'>) {
  return `${adapter.id}\0${message.chatId}`;
}

export function shouldProbePrivateLike(
  adapter: AdapterConfig,
  message: Pick<ChatMessage, 'chatId' | 'userId' | 'kind'>,
  now = Date.now(),
) {
  if (message.kind !== 'group') return false;
  if (!Array.isArray(adapter.ownerUsers) || !adapter.ownerUsers.includes(String(message.userId))) return false;
  const until = negativeCache.get(cacheKey(adapter, message));
  return !until || until <= now;
}

/**
 * A private-like group is an owner-only group that an adapter has completely
 * enumerated for this inbound message.  The positive path is deliberately not
 * cached: a newly joined human revokes the bypass on the next message.
 */
export function privateLikeFromProof(
  adapter: AdapterConfig,
  message: Pick<ChatMessage, 'chatId' | 'userId' | 'kind'>,
  proof: CompleteMemberProof,
  now = Date.now(),
) {
  if (message.kind !== 'group') return false;
  if (!Array.isArray(adapter.ownerUsers) || !adapter.ownerUsers.includes(String(message.userId))) return false;
  const key = cacheKey(adapter, message);
  const until = negativeCache.get(key);
  if (until && until > now) return false;
  if (until) negativeCache.delete(key);
  const value = proof.complete === true && !('privateLike' in proof)
    && proof.nonAgentUserIds.length === 1
    && proof.nonAgentUserIds[0] === String(message.userId);
  if (!value) negativeCache.set(key, now + NEGATIVE_TTL_MS);
  return value;
}

/** Keeps transport semantics as group while exposing the effective private UI policy. */
export function effectivePrivate(message: Pick<ChatMessage, 'kind' | 'privateLike'>) {
  return message.kind === 'dm' || message.privateLike === true;
}

export function clearPrivateLikeCacheForTests() {
  negativeCache.clear();
}
