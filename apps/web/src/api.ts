/**
 * The single boundary between the Rain web client and the Rain API.
 *
 * Nothing else in the app calls `fetch`. That keeps three production rules
 * enforceable in one place:
 *
 *  1. Credentials travel as an HttpOnly session cookie, never in JS-readable
 *     storage, so a script injection cannot exfiltrate a session.
 *  2. Every mutating request carries a double-submit CSRF token.
 *  3. A 401 is a session boundary, not a render error — it clears the client
 *     session instead of leaving stale account data on screen.
 *
 * `docs/api-contract.md` documents the endpoints below. Until a base URL is
 * configured the client reports "not configured" and the UI renders empty
 * rather than inventing data.
 */

import type {
  Account,
  Circle,
  CircleMessage,
  Connection,
  DirectMessage,
  DirectThread,
  Entitlement,
  Page,
  Plan,
  Profile,
  ReportReason,
  Session,
} from "./types";

const baseUrl = (import.meta.env.VITE_API_URL ?? "").replace(/\/$/, "");
const realtimeUrl = import.meta.env.VITE_REALTIME_URL ?? "";
export const isDemoMode = import.meta.env.DEV && import.meta.env.VITE_DEMO_MODE === "true";

/** True once the deployment points at a real API. */
export const isApiConfigured = Boolean(baseUrl) || isDemoMode;
export const isRealtimeConfigured = Boolean(realtimeUrl) || isDemoMode;
export const realtimeEndpoint = realtimeUrl || window.location.origin;

const demoProfile: Profile = {
  id: "demo-profile",
  name: "Rain Developer",
  handle: "rain-dev",
  avatarUrl: null,
  bio: "Previewing Rain locally.",
  identity: "Prefer not to say",
  seeking: "Everyone",
  interests: ["music", "curiosity", "late-night walks"],
  plan: "pro",
  karma: 100,
  createdAt: "2026-01-01T00:00:00.000Z",
};

const demoConnections: Connection[] = [
  { id: "connection-1", profileId: "profile-ava", name: "Ava Chen", handle: "avachen", avatarUrl: null, presence: "online", karma: 94, interests: ["music", "design"] },
  { id: "connection-2", profileId: "profile-noah", name: "Noah Williams", handle: "noahw", avatarUrl: null, presence: "away", karma: 88, interests: ["books", "film"] },
];

let demoDirectMessages: DirectMessage[] = [
  { id: "dm-1", threadId: "thread-1", authorId: "profile-ava", body: "That playlist you shared is excellent.", sentAt: "2026-08-28T14:12:00.000Z" },
  { id: "dm-2", threadId: "thread-1", authorId: "demo-profile", body: "Right? The last track got me.", sentAt: "2026-08-28T14:14:00.000Z" },
];

const demoCircles: Circle[] = [
  { id: "circle-1", slug: "late-night", name: "Late Night", memberCount: 128, live: true },
  { id: "circle-2", slug: "makers", name: "Makers", memberCount: 76, live: false },
];

let demoCircleMessages: CircleMessage[] = [
  { id: "circle-message-1", circleId: "circle-1", authorId: "profile-ava", authorName: "Ava Chen", authorAvatarUrl: null, body: "What is everyone listening to tonight?", sentAt: "2026-08-28T13:52:00.000Z" },
  { id: "circle-message-2", circleId: "circle-1", authorId: "demo-profile", authorName: "Rain Developer", authorAvatarUrl: null, body: "A very atmospheric album from start to finish.", sentAt: "2026-08-28T13:55:00.000Z" },
];

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get isUnauthorized() {
    return this.status === 401;
  }
  get isRateLimited() {
    return this.status === 429;
  }
}

export class ApiNotConfiguredError extends ApiError {
  constructor() {
    super(0, "api_not_configured", "Rain is not connected to its API yet.");
    this.name = "ApiNotConfiguredError";
  }
}

type Listener = () => void;
const unauthorizedListeners = new Set<Listener>();

/** Fires whenever the API rejects the current session. */
export function onUnauthorized(listener: Listener) {
  unauthorizedListeners.add(listener);
  return () => {
    unauthorizedListeners.delete(listener);
  };
}

/**
 * Double-submit CSRF: the server sets a readable `rain_csrf` cookie alongside
 * the HttpOnly session cookie, and we echo it in a header. A cross-site
 * attacker can force the cookie to be sent but cannot read it to set the header.
 */
function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)rain_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

type RequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Set for endpoints whose 401 is an expected answer, not a session loss. */
  allowUnauthorized?: boolean;
};

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  if (!baseUrl) throw new ApiNotConfiguredError();
  const method = options.method ?? "GET";
  const isFormData = options.body instanceof FormData;

  const headers: Record<string, string> = { accept: "application/json" };
  if (options.body !== undefined && !isFormData) headers["content-type"] = "application/json";
  if (method !== "GET") headers["x-rain-csrf"] = csrfToken();

  let response: Response;
  try {
    response = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      credentials: "include",
      signal: options.signal,
      body: options.body === undefined ? undefined : isFormData ? (options.body as FormData) : JSON.stringify(options.body),
    });
  } catch (reason) {
    if (reason instanceof DOMException && reason.name === "AbortError") throw reason;
    throw new ApiError(0, "network_error", "Rain could not reach the network. Check your connection and try again.");
  }

  if (response.status === 401 && !options.allowUnauthorized) {
    unauthorizedListeners.forEach((listener) => listener());
  }

  if (response.status === 204) return undefined as T;

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = (payload ?? {}) as { code?: string; message?: string; fields?: Record<string, string> };
    throw new ApiError(
      response.status,
      detail.code ?? `http_${response.status}`,
      detail.message ?? defaultMessage(response.status),
      detail.fields,
    );
  }
  return payload as T;
}

function defaultMessage(status: number) {
  if (status === 401) return "Your session has ended. Sign in again to continue.";
  if (status === 403) return "Your account does not have access to that.";
  if (status === 404) return "That is no longer available.";
  if (status === 409) return "That conflicts with something that already exists.";
  if (status === 429) return "Too many attempts. Wait a moment and try again.";
  if (status >= 500) return "Rain is having trouble on our side. Try again shortly.";
  return "That request could not be completed.";
}

/* ------------------------------------------------------------------ auth -- */

export const auth = {
  /**
   * Restores the session on page load from the HttpOnly cookie. A signed-out
   * visitor gets `null` rather than an error — that is a normal answer here.
   */
  async session(signal?: AbortSignal): Promise<Session | null> {
    if (isDemoMode) return { account: { id: "demo-account", email: "developer@rain.local", emailVerified: true, createdAt: demoProfile.createdAt }, profile: demoProfile };
    try {
      return await request<Session>("/v1/auth/session", { signal, allowUnauthorized: true });
    } catch (reason) {
      if (reason instanceof ApiError && reason.isUnauthorized) return null;
      throw reason;
    }
  },

  signUp(input: { email: string; password: string; acceptedTerms: boolean }) {
    return request<Session>("/v1/auth/sign-up", { method: "POST", body: input });
  },

  signIn(input: { email: string; password: string }) {
    return request<Session>("/v1/auth/sign-in", { method: "POST", body: input });
  },

  /** Revokes the session server-side. The cookie is cleared by the response. */
  signOut() {
    return request<void>("/v1/auth/sign-out", { method: "POST" });
  },

  requestPasswordReset(email: string) {
    return request<void>("/v1/auth/password/reset-request", { method: "POST", body: { email } });
  },

  resendVerification() {
    if (isDemoMode) return Promise.resolve();
    return request<void>("/v1/auth/email/resend", { method: "POST" });
  },
};

/* --------------------------------------------------------------- profile -- */

export type ProfileDraft = {
  name: string;
  bio: string;
  identity: string;
  seeking: string;
  interests: string[];
  acceptedAgeGate: boolean;
};

export const profiles = {
  /** Called once after sign-up to turn an account into a person. */
  create(draft: ProfileDraft) {
    return request<Profile>("/v1/profile", { method: "POST", body: draft });
  },
  update(patch: Partial<Omit<ProfileDraft, "acceptedAgeGate">>) {
    if (isDemoMode) return Promise.resolve({ ...demoProfile, ...patch, interests: patch.interests ?? demoProfile.interests, identity: patch.identity ?? demoProfile.identity, seeking: patch.seeking ?? demoProfile.seeking });
    return request<Profile>("/v1/profile", { method: "PATCH", body: patch });
  },
  /** Uploads to object storage server-side; returns the stored URL. */
  uploadAvatar(file: File) {
    if (isDemoMode) return Promise.resolve({ avatarUrl: URL.createObjectURL(file) });
    const form = new FormData();
    form.append("avatar", file);
    return request<{ avatarUrl: string }>("/v1/profile/avatar", { method: "POST", body: form });
  },
  deleteAccount(password: string) {
    if (isDemoMode) return Promise.resolve();
    return request<void>("/v1/profile", { method: "DELETE", body: { password } });
  },
};

/* ---------------------------------------------------------------- social -- */

export const social = {
  connections(signal?: AbortSignal) {
    if (isDemoMode) return Promise.resolve(demoConnections);
    return request<Connection[]>("/v1/connections", { signal });
  },
  removeConnection(connectionId: string) {
    return request<void>(`/v1/connections/${connectionId}`, { method: "DELETE" });
  },
  block(profileId: string) {
    return request<void>("/v1/blocks", { method: "POST", body: { profileId } });
  },

  threads(signal?: AbortSignal) {
    if (isDemoMode) return Promise.resolve<DirectThread[]>([{ id: "thread-1", connectionId: "connection-1", lastMessage: demoDirectMessages[demoDirectMessages.length - 1], unreadCount: 0 }]);
    return request<DirectThread[]>("/v1/dm/threads", { signal });
  },
  messages(threadId: string, cursor?: string, signal?: AbortSignal) {
    if (isDemoMode) return Promise.resolve<Page<DirectMessage>>({ items: demoDirectMessages.filter((message) => message.threadId === threadId), nextCursor: null });
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request<Page<DirectMessage>>(`/v1/dm/threads/${threadId}/messages${query}`, { signal });
  },
  /** `clientMessageId` makes a retry idempotent instead of a duplicate send. */
  sendMessage(threadId: string, input: { clientMessageId: string; body: string }) {
    if (isDemoMode) {
      const message: DirectMessage = { id: input.clientMessageId, threadId, authorId: demoProfile.id, body: input.body, sentAt: new Date().toISOString() };
      demoDirectMessages = [...demoDirectMessages, message];
      return Promise.resolve(message);
    }
    return request<DirectMessage>(`/v1/dm/threads/${threadId}/messages`, { method: "POST", body: input });
  },
  markRead(threadId: string, messageId: string) {
    return request<void>(`/v1/dm/threads/${threadId}/read`, { method: "POST", body: { messageId } });
  },
};

/* --------------------------------------------------------------- circles -- */

export const circles = {
  list(signal?: AbortSignal) {
    if (isDemoMode) return Promise.resolve(demoCircles);
    return request<Circle[]>("/v1/circles", { signal });
  },
  messages(circleId: string, cursor?: string, signal?: AbortSignal) {
    if (isDemoMode) return Promise.resolve<Page<CircleMessage>>({ items: demoCircleMessages.filter((message) => message.circleId === circleId), nextCursor: null });
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request<Page<CircleMessage>>(`/v1/circles/${circleId}/messages${query}`, { signal });
  },
  send(circleId: string, input: { clientMessageId: string; body: string }) {
    if (isDemoMode) {
      const message: CircleMessage = { id: input.clientMessageId, circleId, authorId: demoProfile.id, authorName: demoProfile.name, authorAvatarUrl: null, body: input.body, sentAt: new Date().toISOString() };
      demoCircleMessages = [...demoCircleMessages, message];
      return Promise.resolve(message);
    }
    return request<CircleMessage>(`/v1/circles/${circleId}/messages`, { method: "POST", body: input });
  },
  join(circleId: string) {
    return request<Circle>(`/v1/circles/${circleId}/join`, { method: "POST" });
  },
  leave(circleId: string) {
    return request<void>(`/v1/circles/${circleId}/leave`, { method: "POST" });
  },
};

/* --------------------------------------------------------------- billing -- */

export const billing = {
  /** The truth about what a person may do. Read on load, never assumed. */
  entitlement(signal?: AbortSignal) {
    if (isDemoMode) return Promise.resolve<Entitlement>({ plan: "pro", status: "active", renewsAt: "2026-09-28T00:00:00.000Z", cancelAtPeriodEnd: false });
    return request<Entitlement>("/v1/billing/entitlement", { signal });
  },
  /** Returns a Stripe Checkout URL. The webhook — not this call — grants access. */
  startCheckout(plan: Exclude<Plan, "free">) {
    if (isDemoMode) return Promise.resolve({ url: "#demo-checkout" });
    return request<{ url: string }>("/v1/billing/checkout", { method: "POST", body: { plan } });
  },
  openPortal() {
    if (isDemoMode) return Promise.resolve({ url: "#demo-billing-portal" });
    return request<{ url: string }>("/v1/billing/portal", { method: "POST" });
  },
};

/* ------------------------------------------------------- realtime + media -- */

export const realtime = {
  /** Short-lived token the socket presents on connect. Never a raw session. */
  token() {
    if (isDemoMode) return Promise.resolve({ token: "demo-token", expiresAt: new Date(Date.now() + 120_000).toISOString() });
    return request<{ token: string; expiresAt: string }>("/v1/realtime/token", { method: "POST" });
  },
};

export const media = {
  /**
   * Issues a room-scoped SFU token, and only for a match the server agrees is
   * active and mutually consented. Media never flows through the chat socket.
   */
  roomToken(input: { matchId: string; kind: "voice" | "video" }) {
    if (isDemoMode) return Promise.resolve({ token: "demo-room-token", url: "http://localhost:3002", expiresAt: new Date(Date.now() + 120_000).toISOString() });
    return request<{ token: string; url: string; expiresAt: string }>("/v1/media/room-token", {
      method: "POST",
      body: input,
    });
  },
};

/* ---------------------------------------------------------------- safety -- */

export const safety = {
  report(input: { matchId?: string; profileId?: string; reason: ReportReason; details?: string }) {
    if (isDemoMode) return Promise.resolve({ id: "demo-report" });
    return request<{ id: string }>("/v1/reports", { method: "POST", body: input });
  },
};

export type { Account, Profile, Session };
