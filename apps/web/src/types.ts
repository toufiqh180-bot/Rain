/**
 * Shapes the web client exchanges with the Rain API.
 *
 * Every type here is server-owned. The browser never invents an id, a plan, a
 * karma value, or a membership entitlement — it renders what the API returns.
 */

export type Plan = "free" | "plus" | "pro";

/** The authenticated account. Returned by every auth endpoint. */
export type Account = {
  id: string;
  email: string;
  emailVerified: boolean;
  createdAt: string;
};

/** The public-facing half of a person, owned by the profile service. */
export type Profile = {
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  bio: string;
  /** Private matching input. Never sent to a peer. */
  identity: string;
  /** Private matching input. Never sent to a peer. */
  seeking: string;
  interests: string[];
  plan: Plan;
  karma: number;
  createdAt: string;
};

export type Session = { account: Account; profile: Profile | null };

export type Presence = "online" | "away" | "in-a-chat" | "offline";

/** A mutual connection. Only exists after both people accept. */
export type Connection = {
  id: string;
  profileId: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  presence: Presence;
  karma: number;
  interests: string[];
};

export type DirectMessage = {
  id: string;
  threadId: string;
  authorId: string;
  body: string;
  sentAt: string;
};

export type DirectThread = {
  id: string;
  connectionId: string;
  lastMessage: DirectMessage | null;
  unreadCount: number;
};

export type Circle = {
  id: string;
  slug: string;
  name: string;
  memberCount: number;
  live: boolean;
};

export type CircleMessage = {
  id: string;
  circleId: string;
  authorId: string;
  authorName: string;
  authorAvatarUrl: string | null;
  body: string;
  sentAt: string;
};

export type Page<T> = { items: T[]; nextCursor: string | null };

/** Entitlement is read from billing, never from a button in the browser. */
export type Entitlement = {
  plan: Plan;
  status: "active" | "trialing" | "past_due" | "canceled" | "none";
  renewsAt: string | null;
  cancelAtPeriodEnd: boolean;
};

export type ReportReason =
  | "harassment"
  | "sexual-content"
  | "hate"
  | "spam"
  | "minor-safety"
  | "other";

/** Device-local preferences. These are the only values kept in the browser. */
export type DevicePreferences = {
  soundEnabled: boolean;
  reducedMotion: boolean;
};
