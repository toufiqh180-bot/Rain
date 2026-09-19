import { createHmac } from "node:crypto";
import { env, livekitConfigured } from "./env.js";
import { ApiError } from "./http.js";

/**
 * Issues a short-lived LiveKit access token without pulling in the full SDK.
 * HS256 JWT with room join grants scoped to one match room.
 */
export function issueLiveKitToken(input: {
  identity: string;
  name: string;
  roomName: string;
  canPublish: boolean;
  ttlSeconds?: number;
}): { token: string; url: string; expiresAt: string } {
  if (!livekitConfigured) {
    throw ApiError.unavailable("Voice and video rooms are not connected yet.");
  }

  const ttl = input.ttlSeconds ?? 120;
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({
      iss: env.LIVEKIT_API_KEY,
      sub: input.identity,
      name: input.name,
      nbf: Math.floor(Date.now() / 1000) - 5,
      exp: expiresAt,
      video: {
        roomJoin: true,
        room: input.roomName,
        canPublish: input.canPublish,
        canSubscribe: true,
        canPublishData: true,
      },
    }),
  ).toString("base64url");

  const data = `${header}.${payload}`;
  const signature = createHmac("sha256", env.LIVEKIT_API_SECRET!)
    .update(data)
    .digest("base64url");

  return {
    token: `${data}.${signature}`,
    url: env.LIVEKIT_URL!,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
  };
}
