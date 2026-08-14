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

/** True once the deployment points at a real API. */
export const isApiConfigured = Boolean(baseUrl);
export const isRealtimeConfigured = Boolean(realtimeUrl);
export const realtimeEndpoint = realtimeUrl;

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
    return request<Profile>("/v1/profile", { method: "PATCH", body: patch });
  },
  /** Uploads to object storage server-side; returns the stored URL. */
  uploadAvatar(file: File) {
    const form = new FormData();
    form.append("avatar", file);
    return request<{ avatarUrl: string }>("/v1/profile/avatar", { method: "POST", body: form });
  },
  deleteAccount(password: string) {
    return request<void>("/v1/profile", { method: "DELETE", body: { password } });
  },
};

/* ---------------------------------------------------------------- social -- */

export const social = {
  connections(signal?: AbortSignal) {
    return request<Connection[]>("/v1/connections", { signal });
  },
  removeConnection(connectionId: string) {
    return request<void>(`/v1/connections/${connectionId}`, { method: "DELETE" });
  },
  block(profileId: string) {
    return request<void>("/v1/blocks", { method: "POST", body: { profileId } });
  },

  threads(signal?: AbortSignal) {
    return request<DirectThread[]>("/v1/dm/threads", { signal });
  },
  messages(threadId: string, cursor?: string, signal?: AbortSignal) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request<Page<DirectMessage>>(`/v1/dm/threads/${threadId}/messages${query}`, { signal });
  },
  /** `clientMessageId` makes a retry idempotent instead of a duplicate send. */
  sendMessage(threadId: string, input: { clientMessageId: string; body: string }) {
    return request<DirectMessage>(`/v1/dm/threads/${threadId}/messages`, { method: "POST", body: input });
  },
  markRead(threadId: string, messageId: string) {
    return request<void>(`/v1/dm/threads/${threadId}/read`, { method: "POST", body: { messageId } });
  },
};

/* --------------------------------------------------------------- circles -- */

export const circles = {
  list(signal?: AbortSignal) {
    return request<Circle[]>("/v1/circles", { signal });
  },
  messages(circleId: string, cursor?: string, signal?: AbortSignal) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
    return request<Page<CircleMessage>>(`/v1/circles/${circleId}/messages${query}`, { signal });
  },
  send(circleId: string, input: { clientMessageId: string; body: string }) {
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
    return request<Entitlement>("/v1/billing/entitlement", { signal });
  },
  /** Returns a Stripe Checkout URL. The webhook — not this call — grants access. */
  startCheckout(plan: Exclude<Plan, "free">) {
    return request<{ url: string }>("/v1/billing/checkout", { method: "POST", body: { plan } });
  },
  openPortal() {
    return request<{ url: string }>("/v1/billing/portal", { method: "POST" });
  },
};

/* ------------------------------------------------------- realtime + media -- */

export const realtime = {
  /** Short-lived token the socket presents on connect. Never a raw session. */
  token() {
    return request<{ token: string; expiresAt: string }>("/v1/realtime/token", { method: "POST" });
  },
};

export const media = {
  /**
   * Issues a room-scoped SFU token, and only for a match the server agrees is
   * active and mutually consented. Media never flows through the chat socket.
   */
  roomToken(input: { matchId: string; kind: "voice" | "video" }) {
    return request<{ token: string; url: string; expiresAt: string }>("/v1/media/room-token", {
      method: "POST",
      body: input,
    });
  },
};

/* ---------------------------------------------------------------- safety -- */

export const safety = {
  report(input: { matchId?: string; profileId?: string; reason: ReportReason; details?: string }) {
    return request<{ id: string }>("/v1/reports", { method: "POST", body: input });
  },
};

export type { Account, Profile, Session };
