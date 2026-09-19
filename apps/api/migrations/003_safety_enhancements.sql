-- Rain: Safety enhancements for production (device tracking, rate limiting, CAPTCHA)

-- Device fingerprinting for abuse detection and rate limiting
create table device_fingerprints (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid        references accounts (id) on delete cascade,
  fingerprint     text        not null,
  user_agent      text,
  ip              inet,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  risk_score      integer     not null default 0,
  is_blocked      boolean     not null default false
);

create index device_fingerprints_fp_idx on device_fingerprints (lower(fingerprint));
create index device_fingerprints_account_idx on device_fingerprints (account_id);
create index device_fingerprints_ip_idx on device_fingerprints (ip);

-- Per-user rate limit buckets (checked before expensive operations)
create table rate_limit_buckets (
  id              bigserial primary key,
  account_id      uuid        not null references accounts (id) on delete cascade,
  bucket_key      text        not null,  -- e.g. 'match:queue', 'message:send', 'connection:request'
  tokens          integer     not null default 0,
  refilled_at     timestamptz not null default now(),
  check (tokens >= 0 and tokens <= 100)
);

create unique index rate_limit_buckets_key on rate_limit_buckets (account_id, bucket_key);

-- CAPTCHA challenge tracking to prevent replay attacks
create table captcha_challenges (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid        references accounts (id) on delete set null,
  challenge_id    text        not null unique,
  token_hash      text        not null unique,
  action          text        not null,  -- 'signup', 'guest_join', 'match_queue'
  verified        boolean     not null default false,
  expires_at      timestamptz not null,
  created_at      timestamptz not null default now()
);

create index captcha_challenges_expiry_idx on captcha_challenges (expires_at);
create index captcha_challenges_action_idx on captcha_challenges (action, created_at desc);

-- Connection quality and match history for reputation
create table match_history (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid        not null references accounts (id) on delete cascade,
  peer_account_id uuid        references accounts (id) on delete set null,
  match_id        text        not null,
  duration_seconds integer,
  reason_ended    text,  -- 'disconnect', 'next', 'report', 'timeout'
  was_reported    boolean     not null default false,
  created_at      timestamptz not null default now()
);

create index match_history_account_idx on match_history (account_id, created_at desc);
create index match_history_reports_idx on match_history (created_at desc) where was_reported = true;

-- Safety metrics for public health dashboard (anonymized)
create table safety_metrics (
  id              bigserial primary key,
  metric_name     text        not null,  -- 'report_rate', 'abuse_pattern_detected', 'device_blocked', etc
  metric_value    integer     not null,
  bucket_window   timestamptz not null,
  tags            jsonb       not null default '{}',  -- e.g. {"report_reason": "sexual-content"}
  created_at      timestamptz not null default now()
);

create index safety_metrics_window_idx on safety_metrics (bucket_window desc);
create index safety_metrics_metric_idx on safety_metrics (metric_name, bucket_window desc);

-- Guest account auto-deletion schedule
create table guest_account_cleanup (
  id              uuid primary key default gen_random_uuid(),
  account_id      uuid        not null references accounts (id) on delete cascade unique,
  scheduled_for   timestamptz not null,
  reason          text        not null,  -- 'logout', 'inactivity', 'abuse_action'
  created_at      timestamptz not null default now()
);

create index guest_account_cleanup_idx on guest_account_cleanup (scheduled_for);

-- Extend accounts table with is_guest if not already present
-- (Check if column exists before adding to avoid migration errors)
do $$
begin
  if not exists (select 1 from information_schema.columns 
                 where table_name = 'accounts' and column_name = 'is_guest') then
    alter table accounts add column is_guest boolean not null default false;
  end if;
  
  if not exists (select 1 from information_schema.columns 
                 where table_name = 'accounts' and column_name = 'age_gate_verified') then
    alter table accounts add column age_gate_verified boolean not null default false;
  end if;
  
  if not exists (select 1 from information_schema.columns 
                 where table_name = 'accounts' and column_name = 'age_gate_accepted_at') then
    alter table accounts add column age_gate_accepted_at timestamptz;
  end if;
  
  if not exists (select 1 from information_schema.columns 
                 where table_name = 'accounts' and column_name = 'age_gate_version') then
    alter table accounts add column age_gate_version text;
  end if;
end $$;
