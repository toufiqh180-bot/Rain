import { createServer } from "node:http";
import { createAdapter } from "@socket.io/redis-adapter";
import { chatMessageSchema, queuePreferencesSchema, reportSchema, type ClientToServerEvents, type ServerToClientEvents } from "@rain/protocol";
import { Server, type Socket } from "socket.io";
import { loadEnvironment } from "./env.js";
import { type ActiveMatch, type Matchmaker, MemoryMatchmaker } from "./matchmaker.js";
import { createRedisClient, RedisMatchmaker } from "./redis-matchmaker.js";

const environment = loadEnvironment();
const allowedOrigins = environment.ALLOWED_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean);
let ready = false;

type RainSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
const httpServer = createServer((request, response) => {
  if (request.url === "/healthz") {
    response.writeHead(200, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: "ok" }));
  }
  if (request.url === "/readyz") {
    response.writeHead(ready ? 200 : 503, { "content-type": "application/json" });
    return response.end(JSON.stringify({ status: ready ? "ready" : "starting" }));
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
  const recent = ((socket.data.sentAt as number[] | undefined) ?? []).filter((time) => now - time < 5_000);
  if (recent.length >= 10) return false;
  socket.data.sentAt = [...recent, now];
  return true;
}

function emitError(socket: RainSocket, code: string, message: string): void {
  socket.emit("queueError", { code, message });
}

/**
 * Exchanges the client's short-lived handshake token for an account id.
 *
 * The browser never sends its session cookie to this gateway; it asks the API
 * for a narrow, expiring token and presents that instead. When no introspection
 * URL is configured the socket stays anonymous — `loadEnvironment` already
 * refuses that combination in production.
 */
async function authenticate(socket: RainSocket, next: (error?: Error) => void): Promise<void> {
  if (!environment.AUTH_INTROSPECTION_URL) {
    socket.data.accountId = null;
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
        // Proves to the API that this caller is the gateway, not a browser.
        "x-internal-key": environment.INTERNAL_API_KEY ?? "",
      },
      body: JSON.stringify({ token }),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return next(new Error("Rejected handshake token"));
    const payload = (await response.json()) as { accountId?: string; blocked?: boolean };
    if (!payload.accountId || payload.blocked) return next(new Error("Rejected handshake token"));
    socket.data.accountId = payload.accountId;
    return next();
  } catch (error) {
    console.error(JSON.stringify({ event: "handshake_introspection_failed", error: error instanceof Error ? error.message : "unknown" }));
    return next(new Error("Unable to verify handshake token"));
  }
}

function connectGateway(matcher: Matchmaker): void {
  async function closeMatch(socket: RainSocket, notifyPeer = true): Promise<void> {
    const match = await matcher.end(socket.id);
    if (!match || !notifyPeer) return;
    io.to(peerId(match, socket.id)).emit("peerLeft");
  }

  io.use((socket, next) => { void authenticate(socket, next); });

  io.on("connection", (socket) => {
    socket.on("joinQueue", async (input) => {
      const parsed = queuePreferencesSchema.safeParse(input);
      if (!parsed.success) return emitError(socket, "INVALID_PREFERENCES", "Choose valid match settings.");
      try {
        const result = await matcher.join(socket.id, parsed.data);
        if (result.state === "queued") return socket.emit("queueJoined");
        const payload = { matchId: result.match.id, sharedInterests: result.match.sharedInterests };
        socket.emit("matched", payload);
        io.to(result.peerSocketId).emit("matched", payload);
      } catch (error) {
        console.error(JSON.stringify({ event: "matchmaking_failed", error: error instanceof Error ? error.message : "unknown" }));
        emitError(socket, "SERVICE_UNAVAILABLE", "Matching is temporarily unavailable. Please try again.");
      }
    });

    socket.on("leaveQueue", () => { void matcher.leaveQueue(socket.id); });

    socket.on("next", () => {
      void (async () => {
        await closeMatch(socket);
        await matcher.leaveQueue(socket.id);
      })();
    });

    socket.on("message", async (input) => {
      const parsed = chatMessageSchema.safeParse(input);
      if (!parsed.success) return emitError(socket, "INVALID_MESSAGE", "Messages must be between 1 and 1,000 characters.");
      if (!allowedToSend(socket)) return emitError(socket, "RATE_LIMITED", "Slow down for a moment.");
      const match = await matcher.nextMessage(socket.id);
      if (!match) return emitError(socket, "NO_ACTIVE_MATCH", "Find a new match before sending a message.");
      io.to(peerId(match, socket.id)).emit("message", { ...parsed.data, sequence: match.sequence, sentAt: new Date().toISOString() });
    });

    socket.on("reportPeer", async (input) => {
      const parsed = reportSchema.safeParse(input);
      if (!parsed.success) return emitError(socket, "INVALID_REPORT", "Select a report reason.");
      const match = await matcher.end(socket.id);
      if (!match) return emitError(socket, "NO_ACTIVE_MATCH", "There is no active match to report.");
      // The report boundary is intentionally here; persist it via the Postgres outbox in the next service milestone.
      console.info(JSON.stringify({ event: "peer_reported", matchId: match.id, reporterAccountId: socket.data.accountId ?? null, reporterSocketId: socket.id, ...parsed.data }));
      io.to(peerId(match, socket.id)).emit("peerLeft");
      socket.emit("reported");
    });

    socket.on("disconnect", () => {
      void (async () => {
        await matcher.leaveQueue(socket.id);
        await closeMatch(socket);
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
  }
  connectGateway(matcher);
  httpServer.listen(environment.PORT, () => {
    ready = true;
    console.info(JSON.stringify({ event: "gateway_ready", port: environment.PORT, driver: environment.MATCHMAKER_DRIVER }));
  });
}

void bootstrap().catch((error) => {
  console.error(JSON.stringify({ event: "gateway_start_failed", error: error instanceof Error ? error.message : "unknown" }));
  process.exitCode = 1;
});
