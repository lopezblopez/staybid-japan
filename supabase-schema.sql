-- STAYBID JAPAN — full database schema.
-- Run this once, top to bottom, in a fresh Supabase project's SQL Editor.
--
-- The concept (same as outbid.lol): a public ranking where the only way to
-- move up is to pay more than whoever is currently above you. No accounts,
-- no votes, no algorithm — just a list sorted by total yen paid, in the
-- open, forever. Anyone can add a listing or top one up for as little as
-- ¥100, and every total is guaranteed unique — no two listings ever tie.

create extension if not exists pgcrypto;

create table listings (
  id uuid primary key default gen_random_uuid(),
  slug text unique not null,
  name text not null,
  place text,
  total_paid_jpy integer not null default 0,
  image_url text default '',
  website_url text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enforced by Postgres itself, not application code, so it holds even if
-- two payments complete at the exact same moment (see apply_paid_listing).
alter table listings add constraint listings_total_paid_jpy_unique unique (total_paid_jpy);

create table payments (
  id uuid primary key default gen_random_uuid(),
  stripe_session_id text unique not null,
  listing_id uuid references listings(id),
  amount_jpy integer not null,
  status text not null default 'pending',
  created_at timestamptz not null default now()
);

-- Stripe webhook idempotency: an event id is recorded here only after it has
-- been fully processed, so a delivery that fails partway is retried by
-- Stripe rather than silently swallowed as a duplicate on the next attempt.
create table webhook_events (
  stripe_event_id text primary key,
  created_at timestamptz not null default now()
);

alter table listings enable row level security;
alter table payments enable row level security;
alter table webhook_events enable row level security;

-- The ranking is public read-only. All writes go through the service_role
-- key from the serverless functions, which bypasses RLS entirely — so no
-- write policies exist here on purpose.
create policy "Public read listings" on listings for select using (true);

-- Applies one payment to a listing, creating it on first payment. Three
-- things make this safe under real-world concurrency and Stripe's webhook
-- retries:
--
-- 1. A single INSERT ... ON CONFLICT (slug) DO UPDATE, so two payments
--    landing on the same slug at once still both get applied — Postgres
--    serializes the two statements via the row lock, neither is lost.
--
-- 2. The retry loop: if the resulting total would exactly match another
--    listing's total, the unique constraint above rejects the statement
--    (unique_violation), which is caught here and retried 1 yen higher,
--    looping until it lands on a free value. This is what guarantees no
--    two listings ever tie, even when two people pay at literally the
--    same instant for *different* listings.
--
-- 3. The session is applied at most once. The webhook marks a Stripe event
--    processed only *after* this call succeeds, so Stripe redelivering the
--    same event (its own retry, or a slow response racing a duplicate
--    delivery) calls this function again for the same p_stripe_session_id.
--    Without a check here, that would silently add the same payment's yen
--    to the listing's total a second time. The `for update` lock also
--    serializes two concurrent calls for the same session: the second one
--    blocks until the first commits, then sees listing_id already set and
--    exits as a no-op instead of racing it.
create or replace function apply_paid_listing(
  p_slug text,
  p_name text,
  p_place text,
  p_amount integer,
  p_stripe_session_id text,
  p_image_url text default '',
  p_website_url text default ''
) returns void
language plpgsql
as $$
declare
  v_listing_id listings.id%type;
  v_already_applied listings.id%type;
  v_bump integer := 0;
  v_attempt integer := 0;
begin
  select listing_id into v_already_applied
    from payments
    where stripe_session_id = p_stripe_session_id
    for update;
  if not found then
    -- Without this row there is nothing to mark as applied, so a retry
    -- could not tell it had already run and would add the amount twice.
    -- Refusing is what makes the guarantee hold: the caller returns an
    -- error, Stripe retries, and by then the row will be there.
    raise exception 'apply_paid_listing: no payment row for session %', p_stripe_session_id;
  end if;
  if v_already_applied is not null then
    return; -- already applied by an earlier call, nothing to do
  end if;

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 1000 then
      raise exception 'apply_paid_listing: no free total_paid_jpy value found after % attempts', v_attempt;
    end if;

    begin
      insert into listings (slug, name, place, total_paid_jpy, image_url, website_url)
      values (p_slug, p_name, nullif(p_place, ''), p_amount + v_bump, nullif(p_image_url, ''), nullif(p_website_url, ''))
      on conflict (slug) do update
        set total_paid_jpy = listings.total_paid_jpy + p_amount + v_bump,
            image_url = coalesce(nullif(excluded.image_url, ''), listings.image_url),
            website_url = coalesce(nullif(excluded.website_url, ''), listings.website_url),
            updated_at = now()
      returning id into v_listing_id;
      exit; -- succeeded, no collision
    exception when unique_violation then
      -- Another listing already holds exactly that total; try 1 yen higher.
      v_bump := v_bump + 1;
    end;
  end loop;

  update payments
    set status = 'completed', listing_id = v_listing_id
    where stripe_session_id = p_stripe_session_id;
end;
$$;
