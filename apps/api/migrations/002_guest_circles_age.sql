-- Guest accounts, age-gate evidence, and default Circles.

alter table accounts
  alter column email drop not null,
  alter column password_hash drop not null,
  add column if not exists is_guest boolean not null default false,
  add column if not exists age_gate_accepted_at timestamptz,
  add column if not exists age_gate_version text;

-- Guests never have an email; registered accounts still need a unique email.
drop index if exists accounts_email_key;
create unique index accounts_email_key on accounts (lower(email))
  where deleted_at is null and email is not null;

create index accounts_guest_idx on accounts (created_at) where is_guest = true and deleted_at is null;

-- Seed a few Circles so group mode is never an empty list on a fresh deploy.
insert into circles (slug, name)
select v.slug, v.name
  from (values
    ('general', 'General'),
    ('music', 'Music'),
    ('gaming', 'Gaming'),
    ('late-night', 'Late Night')
  ) as v(slug, name)
 where not exists (select 1 from circles c where lower(c.slug) = lower(v.slug));
