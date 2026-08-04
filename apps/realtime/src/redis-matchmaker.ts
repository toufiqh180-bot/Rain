import { randomUUID } from "node:crypto";
import type { QueuePreferences } from "@rain/protocol";
import { createClient, type RedisClientType } from "redis";
import type { ActiveMatch, Matchmaker, QueueResult } from "./matchmaker.js";

type Redis = RedisClientType;
const matchTtlMs = 30 * 60 * 1_000;

/**
 * Atomically pairs people in one language lane. Every key for a lane shares a
 * Redis Cluster hash tag, so this continues to work when Redis is sharded.
 */
const joinScript = `
local queue = KEYS[1]
local waiting = KEYS[2]
local socketId = ARGV[1]
local preferences = cjson.decode(ARGV[2])
local matchId = ARGV[3]
local now = ARGV[4]
local ttl = ARGV[5]
local base = string.sub(queue, 1, -7)

redis.call('ZREM', queue, socketId)
redis.call('HDEL', waiting, socketId)
local candidates = redis.call('ZRANGE', queue, 0, 99)
for _, candidateId in ipairs(candidates) do
  local encoded = redis.call('HGET', waiting, candidateId)
  if not encoded then
    redis.call('ZREM', queue, candidateId)
  else
    local candidate = cjson.decode(encoded)
    local shared = {}
    local candidateInterests = {}
    for _, value in ipairs(candidate.interests) do candidateInterests[value] = true end
    for _, value in ipairs(preferences.interests) do
      if candidateInterests[value] then table.insert(shared, value) end
    end
    local compatible = (#candidate.interests == 0 and #preferences.interests == 0) or #shared > 0
    if compatible then
      local match = { id = matchId, sockets = { candidateId, socketId }, sequence = 0, sharedInterests = shared }
      local encodedMatch = cjson.encode(match)
      redis.call('ZREM', queue, candidateId)
      redis.call('HDEL', waiting, candidateId)
      redis.call('SET', base .. ':match:' .. candidateId, encodedMatch, 'PX', ttl)
      redis.call('SET', base .. ':match:' .. socketId, encodedMatch, 'PX', ttl)
      return encodedMatch
    end
  end
end
redis.call('ZADD', queue, now, socketId)
redis.call('HSET', waiting, socketId, ARGV[2])
return ''
`;

const endScript = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return '' end
local match = cjson.decode(encoded)
local peer = match.sockets[1]
if peer == ARGV[1] then peer = match.sockets[2] end
local base = string.gsub(KEYS[1], ':match:[^:]+$', '')
redis.call('DEL', KEYS[1])
redis.call('DEL', base .. ':match:' .. peer)
return encoded
`;

const messageScript = `
local encoded = redis.call('GET', KEYS[1])
if not encoded then return '' end
local match = cjson.decode(encoded)
match.sequence = match.sequence + 1
local renewed = cjson.encode(match)
local peer = match.sockets[1]
if peer == ARGV[1] then peer = match.sockets[2] end
local base = string.gsub(KEYS[1], ':match:[^:]+$', '')
redis.call('SET', KEYS[1], renewed, 'PX', ARGV[2])
redis.call('SET', base .. ':match:' .. peer, renewed, 'PX', ARGV[2])
return renewed
`;

export class RedisMatchmaker implements Matchmaker {
  private readonly lanes = new Map<string, string>();

  constructor(private readonly redis: Redis, private readonly prefix = "rain") {}

  async join(socketId: string, preferences: QueuePreferences): Promise<QueueResult> {
    const lane = preferences.language.toLowerCase();
    await this.leaveQueue(socketId);
    await this.end(socketId);
    this.lanes.set(socketId, lane);
    const raw = await this.redis.eval(joinScript, {
      keys: [this.queueKey(lane), this.waitingKey(lane)],
      arguments: [socketId, JSON.stringify(preferences), randomUUID(), String(Date.now()), String(matchTtlMs)],
    }) as string;
    if (!raw) return { state: "queued" };
    const match = JSON.parse(raw) as ActiveMatch;
    const peerSocketId = match.sockets[0] === socketId ? match.sockets[1] : match.sockets[0];
    return { state: "matched", match, peerSocketId };
  }

  async leaveQueue(socketId: string): Promise<void> {
    const lane = this.lanes.get(socketId);
    if (!lane) return;
    await this.redis.multi()
      .zRem(this.queueKey(lane), socketId)
      .hDel(this.waitingKey(lane), socketId)
      .exec();
  }

  async end(socketId: string): Promise<ActiveMatch | undefined> {
    const lane = this.lanes.get(socketId);
    if (!lane) return undefined;
    const raw = await this.redis.eval(endScript, { keys: [this.matchKey(lane, socketId)], arguments: [socketId] }) as string;
    this.lanes.delete(socketId);
    return raw ? JSON.parse(raw) as ActiveMatch : undefined;
  }

  async nextMessage(socketId: string): Promise<ActiveMatch | undefined> {
    const lane = this.lanes.get(socketId);
    if (!lane) return undefined;
    const raw = await this.redis.eval(messageScript, { keys: [this.matchKey(lane, socketId)], arguments: [socketId, String(matchTtlMs)] }) as string;
    return raw ? JSON.parse(raw) as ActiveMatch : undefined;
  }

  async close(): Promise<void> { await this.redis.quit(); }

  private base(lane: string): string { return `${this.prefix}:{${lane}}`; }
  private queueKey(lane: string): string { return `${this.base(lane)}:queue`; }
  private waitingKey(lane: string): string { return `${this.base(lane)}:waiting`; }
  private matchKey(lane: string, socketId: string): string { return `${this.base(lane)}:match:${socketId}`; }
}

export async function createRedisClient(url: string): Promise<Redis> {
  const client = createClient({ url });
  client.on("error", (error) => console.error(JSON.stringify({ event: "redis_error", error: error.message })));
  await client.connect();
  return client as Redis;
}
