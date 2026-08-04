import { randomUUID } from "node:crypto";
import type { QueuePreferences } from "@rain/protocol";

export interface ActiveMatch {
  id: string;
  sockets: readonly [string, string];
  sequence: number;
  sharedInterests: string[];
}

export type QueueResult =
  | { state: "queued" }
  | { state: "matched"; match: ActiveMatch; peerSocketId: string };

/**
 * The application only knows this port. Memory and Redis use the identical
 * semantics, which makes a local setup and a horizontally scaled deployment
 * interchangeable to the Socket.IO gateway.
 */
export interface Matchmaker {
  join(socketId: string, preferences: QueuePreferences): Promise<QueueResult>;
  leaveQueue(socketId: string): Promise<void>;
  end(socketId: string): Promise<ActiveMatch | undefined>;
  nextMessage(socketId: string): Promise<ActiveMatch | undefined>;
  close?(): Promise<void>;
}

interface QueuedUser {
  socketId: string;
  preferences: QueuePreferences;
}

/** Local development/test implementation. Never select this driver in production. */
export class MemoryMatchmaker implements Matchmaker {
  private readonly queues = new Map<string, QueuedUser[]>();
  private readonly queuedBySocket = new Map<string, string>();
  private readonly matchBySocket = new Map<string, ActiveMatch>();

  async join(socketId: string, preferences: QueuePreferences): Promise<QueueResult> {
    this.removeFromQueue(socketId);
    await this.end(socketId);

    const key = preferences.language.toLowerCase();
    const queue = this.queues.get(key) ?? [];
    const peerIndex = queue.findIndex((candidate) => compatible(candidate.preferences, preferences));
    const peer = peerIndex === -1 ? undefined : queue.splice(peerIndex, 1)[0];
    if (queue.length === 0) this.queues.delete(key);
    else this.queues.set(key, queue);

    if (!peer) {
      this.queues.set(key, [...queue, { socketId, preferences }]);
      this.queuedBySocket.set(socketId, key);
      return { state: "queued" };
    }

    this.queuedBySocket.delete(peer.socketId);
    const match: ActiveMatch = {
      id: randomUUID(),
      sockets: [peer.socketId, socketId],
      sequence: 0,
      sharedInterests: sharedInterests(peer.preferences, preferences),
    };
    this.matchBySocket.set(peer.socketId, match);
    this.matchBySocket.set(socketId, match);
    return { state: "matched", match, peerSocketId: peer.socketId };
  }

  async leaveQueue(socketId: string): Promise<void> {
    this.removeFromQueue(socketId);
  }

  async end(socketId: string): Promise<ActiveMatch | undefined> {
    const match = this.matchBySocket.get(socketId);
    if (!match) return undefined;
    for (const participant of match.sockets) this.matchBySocket.delete(participant);
    return match;
  }

  async nextMessage(socketId: string): Promise<ActiveMatch | undefined> {
    const match = this.matchBySocket.get(socketId);
    if (!match) return undefined;
    match.sequence += 1;
    return match;
  }

  private removeFromQueue(socketId: string): void {
    const key = this.queuedBySocket.get(socketId);
    if (!key) return;
    const remaining = (this.queues.get(key) ?? []).filter((user) => user.socketId !== socketId);
    if (remaining.length) this.queues.set(key, remaining);
    else this.queues.delete(key);
    this.queuedBySocket.delete(socketId);
  }
}

export function sharedInterests(first: QueuePreferences, second: QueuePreferences): string[] {
  const other = new Set(second.interests);
  return first.interests.filter((interest) => other.has(interest));
}

export function compatible(first: QueuePreferences, second: QueuePreferences): boolean {
  // Empty interests intentionally retain the classic random-chat experience.
  if (first.interests.length === 0 && second.interests.length === 0) return true;
  return sharedInterests(first, second).length > 0;
}
