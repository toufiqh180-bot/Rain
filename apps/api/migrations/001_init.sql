-- Rain: initial schema.
--
-- Two rules shape this file:
--   1. Random text, voice and video rooms have no table. They are ephemeral by
--      design and their transcripts are never written.
--   2. Anything that decides what a person may do — entitlements, blocks,
--      moderation — lives here, never in the browser.

create extension if not exists pgcrypto;

-- Accounts --------------------------------------------------------------------

create table accounts (
  id                  uuid primary key default gen_random_uuid(),
  email               text        not null,
  password_hash       text        not null,
  email_verified      boolean     not null default false,
  terms_version       text        not null,
  terms_accepted_at   timestamptz not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  deleted_at          timestamptz
);

-- Emails are normalised to lowercase by the application; this enforces it in
-- storage so a second path cannot introduce a duplicate identity.
create unique index accounts_email_key on accounts (lower(email)) where deleted_at is null;

create table sessions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        not null references accounts (id) on delete cascade,
  -- The cookie holds a random token; only its hash is stored, so a database
  -- leak does not hand over live sessions.
  token_hash  text        not null unique,
  csrf_token  text        not null,
  user_agent  text,
  ip          inet,
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz
);

create index sessions_account_idx on sessions (account_id) where revoked_at is null;
create index sessions_expiry_idx on sessions (expires_at) where revoked_at is null;

-- Brute-force protection has to be shared across API instances, so it lives in
-- Postgres rather than in one process's memory.
create table login_attempts (
  id          bigserial primary key,
  email       text        not null,
  ip          inet,
  succeeded   boolean     not null,
  created_at  timestamptz not null default now()
);

create index login_attempts_email_idx on login_attempts (lower(email), created_at desc);
create index login_attempts_ip_idx on login_attempts (ip, created_at desc);

-- Single-use, expiring tokens for email verification and password reset.
create table account_tokens (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        not null references accounts (id) on delete cascade,
  purpose     text        not null check (purpose in ('email_verify', 'password_reset')),
  token_hash  text        not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create index account_tokens_account_idx on account_tokens (account_id, purpose);

-- Short-lived tokens the browser presents to the realtime gateway, so the
-- session cookie itself never leaves the API's origin.
create table realtime_tokens (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        not null references accounts (id) on delete cascade,
  token_hash  text        not null unique,
  expires_at  timestamptz not null,
  consumed_at timestamptz
);

create index realtime_tokens_expiry_idx on realtime_tokens (expires_at);

-- Profiles --------------------------------------------------------------------

create table profiles (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        not null unique references accounts (id) on delete cascade,
  name        text        not null check (char_length(name) between 2 and 24),
  handle      text        not null,
  avatar_url  text,
  bio         text        not null default '' check (char_length(bio) <= 120),
  -- Private matching inputs. Never included in a payload describing this
  -- person to anyone else.
  identity    text        not null default 'Prefer not to say',
  seeking     text        not null default 'Everyone',
  interests   text[]      not null default '{}' check (array_length(interests, 1) is null or array_length(interests, 1) <= 5),
  karma       integer     not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create unique index profiles_handle_key on profiles (lower(handle));

-- Social ----------------------------------------------------------------------

create table connection_requests (
  id            uuid primary key default gen_random_uuid(),
  from_profile  uuid        not null references profiles (id) on delete cascade,
  to_profile    uuid        not null references profiles (id) on delete cascade,
  status        text        not null default 'pending' check (status in ('pending', 'accepted', 'declined')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  check (from_profile <> to_profile)
);

create unique index connection_requests_pending_key
  on connection_requests (from_profile, to_profile) where status = 'pending';

create table dm_threads (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now()
);

-- One row per direction. A mutual connection is two rows, which makes "list my
-- connections" a single indexed lookup instead of an OR across two columns.
create table connections (
  id              uuid primary key default gen_random_uuid(),
  profile_id      uuid        not null references profiles (id) on delete cascade,
  peer_profile_id uuid        not null references profiles (id) on delete cascade,
  thread_id       uuid        not null references dm_threads (id) on delete cascade,
  created_at      timestamptz not null default now(),
  check (profile_id <> peer_profile_id)
);

create unique index connections_pair_key on connections (profile_id, peer_profile_id);
create index connections_owner_idx on connections (profile_id, created_at desc);

create table blocks (
  blocker_profile_id uuid        not null references profiles (id) on delete cascade,
  blocked_profile_id uuid        not null references profiles (id) on delete cascade,
  created_at         timestamptz not null default now(),
  primary key (blocker_profile_id, blocked_profile_id)
);

create table dm_thread_members (
  thread_id            uuid not null references dm_threads (id) on delete cascade,
  profile_id           uuid not null references profiles (id) on delete cascade,
  last_read_message_id uuid,
  primary key (thread_id, profile_id)
);

create table dm_messages (
  id                 uuid primary key default gen_random_uuid(),
  thread_id          uuid        not null references dm_threads (id) on delete cascade,
  author_profile_id  uuid        not null references profiles (id) on delete cascade,
  -- The browser's idempotency key: a retry after a flaky network updates
  -- nothing instead of posting a duplicate.
  client_message_id  uuid        not null,
  body               text        not null check (char_length(body) between 1 and 1000),
  sent_at            timestamptz not null default now()
);

create unique index dm_messages_idempotency_key on dm_messages (thread_id, client_message_id);
-- Matches the keyset pagination order used by the messages endpoint.
create index dm_messages_page_idx on dm_messages (thread_id, sent_at desc, id desc);

-- Circles ---------------------------------------------------------------------

create table circles (
  id          uuid primary key default gen_random_uuid(),
  slug        text        not null,
  name        text        not null,
  created_at  timestamptz not null default now()
);

create unique index circles_slug_key on circles (lower(slug));

create table circle_members (
  circle_id   uuid        not null references circles (id) on delete cascade,
  profile_id  uuid        not null references profiles (id) on delete cascade,
  joined_at   timestamptz not null default now(),
  primary key (circle_id, profile_id)
);

create table circle_messages (
  id                 uuid primary key default gen_random_uuid(),
  circle_id          uuid        not null references circles (id) on delete cascade,
  author_profile_id  uuid        not null references profiles (id) on delete cascade,
  client_message_id  uuid        not null,
  body               text        not null check (char_length(body) between 1 and 1000),
  sent_at            timestamptz not null default now()
);

create unique index circle_messages_idempotency_key on circle_messages (circle_id, client_message_id);
create index circle_messages_page_idx on circle_messages (circle_id, sent_at desc, id desc);

-- Billing ---------------------------------------------------------------------

-- Written only by the Stripe webhook. No request from a browser touches this.
create table subscriptions (
  account_id             uuid primary key references accounts (id) on delete cascade,
  stripe_customer_id     text unique,
  stripe_subscription_id text unique,
  plan                   text        not null default 'free' check (plan in ('free', 'plus', 'pro')),
  status                 text        not null default 'none' check (status in ('active', 'trialing', 'past_due', 'canceled', 'none')),
  current_period_end     timestamptz,
  cancel_at_period_end   boolean     not null default false,
  updated_at             timestamptz not null default now()
);

-- Stripe retries webhooks. Recording the event id makes replay a no-op.
create table processed_stripe_events (
  event_id     text primary key,
  processed_at timestamptz not null default now()
);

-- Safety ----------------------------------------------------------------------

create table reports (
  id                  uuid primary key default gen_random_uuid(),
  reporter_account_id uuid        references accounts (id) on delete set null,
  subject_profile_id  uuid        references profiles (id) on delete set null,
  -- Opaque id of the ephemeral room. There is no matches table to join to;
  -- that is deliberate.
  match_id            text,
  reason              text        not null check (reason in ('harassment', 'sexual-content', 'hate', 'spam', 'minor-safety', 'other')),
  details             text        check (char_length(details) <= 500),
  status              text        not null default 'open' check (status in ('open', 'reviewing', 'actioned', 'dismissed')),
  created_at          timestamptz not null default now()
);

create index reports_triage_idx on reports (status, created_at desc);
-- Minor-safety reports must never sit behind a queue of spam reports.
create index reports_escalation_idx on reports (created_at desc) where reason = 'minor-safety';

create table moderation_actions (
  id          uuid primary key default gen_random_uuid(),
  account_id  uuid        not null references accounts (id) on delete cascade,
  report_id   uuid        references reports (id) on delete set null,
  action      text        not null check (action in ('warn', 'mute', 'suspend', 'ban')),
  expires_at  timestamptz,
  reason      text        not null,
  created_at  timestamptz not null default now()
);

-- Live enforcement reads this: is this account currently barred from matching?
create index moderation_active_idx on moderation_actions (account_id, expires_at)
  where action in ('suspend', 'ban');

create table audit_log (
  id          bigserial primary key,
  account_id  uuid        references accounts (id) on delete set null,
  action      text        not null,
  metadata    jsonb       not null default '{}',
  created_at  timestamptz not null default now()
);

create index audit_log_account_idx on audit_log (account_id, created_at desc);

-- Written in the same transaction as the thing it describes, so a report and
-- its moderation job can never disagree about whether they happened.
create table outbox (
  id            bigserial primary key,
  topic         text        not null,
  payload       jsonb       not null,
  created_at    timestamptz not null default now(),
  processed_at  timestamptz,
  attempts      integer     not null default 0
);

create index outbox_pending_idx on outbox (created_at) where processed_at is null;
