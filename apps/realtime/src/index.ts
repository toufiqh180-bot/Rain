import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import {
  chatMessageSchema,
  queuePreferencesSchema,
  reportSchema,
  type ClientToServerEvents,
  type QueuePreferences,
  type ServerToClientEvents,
} from "@rain/protocol";
import { Server, type Socket } from "socket.io";
import { loadEnvironment } from "./env.js";
import { type ActiveMatch, type Matchmaker, MemoryMatchmaker } from "./matchmaker.js";
import { createRedisClient, RedisMatchmaker } from "./redis-matchmaker.js";

const environment = loadEnvironment();
const allowedOrigins = environment.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
let ready = false;
let redisHealth: { ping(): Promise<string> } | null = null;

type RainSocket = Socket<ClientToServerEvents, ServerToClientEvents> & {
  data: {
    accountId?: string | null;
    profileId?: string | null;
    plan?: string;
    blockedProfileIds?: string[];
    sentAt?: number[];
    mediaReady?: { matchId: string; kind: "voice" | "video" } | null;
  };
};

const httpServer = createServer(async (request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: "ok" }));
  }
  if (request.url === "/readyz") {
    let redisOk = environment.MATCHMAKER_DRIVER !== "redis";
    if (redisHealth) {
      try {
        await redisHealth.ping();
        redisOk = true;
      } catch {
        redisOk = false;
      }
    }
    const ok = ready && redisOk;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: ok ? "ready" : "starting", redis: redisOk }));
  }
  response.writeHead(404).end();
});

const io = new Server<ClientToServerEvents, ServerToClientEvents>(httpServer, {
  cors: {
    origin(origin: string | undefined, callback: (error: Error | null, allow?: boolean) => void) {
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      return callback(new Error("Origin is not allowed by this realtime gateway"), false);
    },
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 4_096,
  pingInterval: 25_000,
  pingTimeout: 20_000,
});

function peerId(match: ActiveMatch, socketId: string): string {
  return match.sockets[0] === socketId ? match.sockets[1] : match.sockets[0];
}

function allowedToSend(socket: RainSocket): boolean {
  const now = Date.now();
  const recent = (socket.data.sentAt ?? []).filter((time: number) => now - time < 5_000);
  if (recent.length >= 10) return false;
  socket.data.sentAt = [...recent, now];
  return true;
}

function emitError(socket: RainSocket, code: string, message: string): void {
  socket.emit("queueError", { code, message });
}

async function setPresence(profileId: string | null | undefined, state: string): Promise<void> {
  if (!profileId || !redisHealth || !("set" in redisHealth)) return;
  try {
    const client = redisHealth as unknown as {
      set(key: string, value: string, opts: { EX: number }): Promise<unknown>;
      del(key: string): Promise<unknown>;
    };
    if (state === "offline") await client.del(`presence:${profileId}`);
    else await client.set(`presence:${profileId}`, state, { EX: 90 });
  } catch {
    // Presence must never break chatting.
  }
}

async function authenticate(socket: RainSocket, next: (error?: Error) => void): Promise<void> {
  if (!environment.AUTH_INTROSPECTION_URL) {
    socket.data.accountId = null;
    socket.data.profileId = null;
    socket.data.blockedProfileIds = [];
    socket.data.plan = "free";
    return next();
  }
  const token = (socket.handshake.auth as { token?: unknown } | undefined)?.token;
  if (typeof token !== "string" || token.length === 0) return next(new Error("Missing handshake token"));
  try {
    const response = await fetch(environment.AUTH_INTROSPECTION_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-internal-key": environment.INTERNAL_API_KEY ?? "",
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return next(new Error("Rejected handshake token"));
    const payload = (await response.json()) as {
      accountId?: string;
      profileId?: string | null;
      blocked?: boolean;
      blockedProfileIds?: string[];
      plan?: string;
    };
    if (!payload.accountId || payload.blocked) return next(new Error("Rejected handshake token"));
    socket.data.accountId = payload.accountId;
    socket.data.profileId = payload.profileId ?? null;
    socket.data.blockedProfileIds = payload.blockedProfileIds ?? [];
    socket.data.plan = payload.plan ?? "free";
    return next();
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "handshake_introspection_failed",
        error: error instanceof Error ? error.message : "unknown",
      }),
    );
    return next(new Error("Unable to verify handshake token"));
  }
}

/** Strip paid preference fields when the account is on Free. */
function entitlementPreferences(socket: RainSocket, preferences: QueuePreferences): QueuePreferences {
  if (socket.data.plan === "plus" || socket.data.plan === "pro") return preferences;
  return { language: preferences.language, interests: preferences.interests.slice(0, 3) };
}

function connectGateway(matcher: Matchmaker): void {
  async function closeMatch(socket: RainSocket, notifyPeer = true): Promise<void> {
    const match = await matcher.end(socket.id);
    if (!match || !notifyPeer) return;
    io.to(peerId(match, socket.id)).emit("peerLeft");
  }

  io.use((socket, next) => {
    void authenticate(socket as RainSocket, next);
  });

  io.on("connection", (socketRaw) => {
    const socket = socketRaw as RainSocket;
    void setPresence(socket.data.profileId, "online");

    socket.on("joinQueue", async (input) => {
      const parsed = queuePreferencesSchema.safeParse(input);
      if (!parsed.success) return emitError(socket, "INVALID_PREFERENCES", "Choose valid match settings.");
      const preferences = entitlementPreferences(socket, parsed.data);
      try {
        const result = await matcher.join(socket.id, preferences);
        if (result.state === "queued") {
          void setPresence(socket.data.profileId, "online");
          return socket.emit("queueJoined");
        }

        const peer = io.sockets.sockets.get(result.peerSocketId) as RainSocket | undefined;
        const blocked =
          (peer?.data.profileId && socket.data.blockedProfileIds?.includes(peer.data.profileId)) ||
          (socket.data.profileId && peer?.data.blockedProfileIds?.includes(socket.data.profileId));
        if (blocked) {
          await matcher.end(socket.id);
          emitError(socket, "MATCH_UNAVAILABLE", "Could not find a compatible match. Try again.");
          if (peer) emitError(peer, "MATCH_UNAVAILABLE", "Could not find a compatible match. Try again.");
          return;
        }

        void setPresence(socket.data.profileId, "in-a-chat");
        void setPresence(peer?.data.profileId, "in-a-chat");

        socket.emit("matched", {
          matchId: result.match.id,
          sharedInterests: result.match.sharedInterests,
          peerProfileId: peer?.data.profileId ?? null,
        });
        peer?.emit("matched", {
          matchId: result.match.id,
          sharedInterests: result.match.sharedInterests,
          peerProfileId: socket.data.profileId ?? null,
        });
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "matchmaking_failed",
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
        emitError(socket, "SERVICE_UNAVAILABLE", "Matching is temporarily unavailable. Please try again.");
      }
    });

    socket.on("leaveQueue", () => {
      void matcher.leaveQueue(socket.id);
    });

    socket.on("next", () => {
      void (async () => {
        await closeMatch(socket);
        await matcher.leaveQueue(socket.id);
        void setPresence(socket.data.profileId, "online");
      })();
    });

    socket.on("message", async (input) => {
      const parsed = chatMessageSchema.safeParse(input);
      if (!parsed.success) return emitError(socket, "INVALID_MESSAGE", "Messages must be between 1 and 1,000 characters.");
      if (!allowedToSend(socket)) return emitError(socket, "RATE_LIMITED", "Slow down for a moment.");
      const match = await matcher.nextMessage(socket.id);
      if (!match) return emitError(socket, "NO_ACTIVE_MATCH", "Find a new match before sending a message.");
      io.to(peerId(match, socket.id)).emit("message", {
        ...parsed.data,
        sequence: match.sequence,
        sentAt: new Date().toISOString(),
      });
    });

    socket.on("reportPeer", async (input) => {
      const parsed = reportSchema.safeParse(input);
      if (!parsed.success) return emitError(socket, "INVALID_REPORT", "Select a report reason.");
      const match = await matcher.end(socket.id);
      if (!match) return emitError(socket, "NO_ACTIVE_MATCH", "There is no active match to report.");
      const peer = io.sockets.sockets.get(peerId(match, socket.id)) as RainSocket | undefined;

      if (environment.REPORT_INGEST_URL && socket.data.accountId) {
        try {
          await fetch(environment.REPORT_INGEST_URL, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-internal-key": environment.INTERNAL_API_KEY ?? "",
            },
            body: JSON.stringify({
              accountId: socket.data.accountId,
              subjectProfileId: peer?.data.profileId ?? undefined,
              matchId: match.id,
              reason: parsed.data.reason,
              details: parsed.data.details,
            }),
            signal: AbortSignal.timeout(3_000),
          });
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "report_ingest_failed",
              error: error instanceof Error ? error.message : "unknown",
            }),
          );
        }
      } else {
        console.info(
          JSON.stringify({
            event: "peer_reported",
            matchId: match.id,
            reporterAccountId: socket.data.accountId ?? null,
            ...parsed.data,
          }),
        );
      }

      peer?.emit("peerLeft");
      socket.emit("reported");
      void setPresence(socket.data.profileId, "online");
    });

    socket.on("mediaReady", (input) => {
      void (async () => {
        const match = await matcher.nextMessage(socket.id);
        if (!match || match.id !== input.matchId) {
          return emitError(socket, "NO_ACTIVE_MATCH", "Find a match before starting media.");
        }
        socket.data.mediaReady = { matchId: input.matchId, kind: input.kind };
        const peer = io.sockets.sockets.get(peerId(match, socket.id)) as RainSocket | undefined;
        peer?.emit("mediaPeerReady", { matchId: input.matchId, kind: input.kind });
        if (peer?.data.mediaReady?.matchId === input.matchId && peer.data.mediaReady.kind === input.kind) {
          socket.emit("mediaBothReady", { matchId: input.matchId, kind: input.kind });
          peer.emit("mediaBothReady", { matchId: input.matchId, kind: input.kind });
        }
      })();
    });

    socket.on("mediaLeave", () => {
      socket.data.mediaReady = null;
    });

    socket.on("disconnect", () => {
      void (async () => {
        await matcher.leaveQueue(socket.id);
        await closeMatch(socket);
        void setPresence(socket.data.profileId, "offline");
      })();
    });
  });
}

async function bootstrap(): Promise<void> {
  let matcher: Matchmaker = new MemoryMatchmaker();
  if (environment.MATCHMAKER_DRIVER === "redis") {
    const pubClient = await createRedisClient(environment.REDIS_URL!);
    const subClient = pubClient.duplicate();
    await subClient.connect();
    io.adapter(createAdapter(pubClient, subClient));
    matcher = new RedisMatchmaker(pubClient);
    redisHealth = pubClient;
  }
  connectGateway(matcher);

  const server = httpServer.listen(environment.PORT, () => {
    ready = true;
    console.info(
      JSON.stringify({
        event: "gateway_ready",
        port: environment.PORT,
        driver: environment.MATCHMAKER_DRIVER,
      }),
    );
  });

  const drain = (signal: string) => {
    console.info(JSON.stringify({ event: "gateway_shutting_down", signal }));
    ready = false;
    server.close(() => {
      void matcher.close?.();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on("SIGTERM", () => drain("SIGTERM"));
  process.on("SIGINT", () => drain("SIGINT"));
}

void bootstrap().catch((error) => {
  console.error(
    JSON.stringify({
      event: "gateway_start_failed",
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  process.exitCode = 1;
});
