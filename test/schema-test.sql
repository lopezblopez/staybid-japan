-- Exercises the guarantees supabase-schema.sql is supposed to provide.
-- Run against a throwaway database that already has the schema loaded:
--
--   createdb staybid_test
--   psql -d staybid_test -f ../supabase-schema.sql
--   psql -d staybid_test -f schema-test.sql
--
-- Every block prints what it expects. Anything else is a regression.

\echo '--- 1. First payment creates the listing ---'
insert into payments (stripe_session_id, amount_jpy, status) values ('sess_A', 500, 'pending');
update payments set status = 'completed' where stripe_session_id = 'sess_A';
select apply_paid_listing('yado-a', 'Yado A', 'Nagano', 500, 'sess_A', '', 'https://example.com');
select slug, total_paid_jpy from listings where slug = 'yado-a';
\echo 'EXPECT: yado-a = 500'

\echo ''
\echo '--- 2. The same webhook delivered twice must NOT double the total ---'
select apply_paid_listing('yado-a', 'Yado A', 'Nagano', 500, 'sess_A', '', 'https://example.com');
select slug, total_paid_jpy from listings where slug = 'yado-a';
\echo 'EXPECT: yado-a = 500 (still) — not 1000'

\echo ''
\echo '--- 3. A tie is resolved automatically, 1 yen higher ---'
insert into payments (stripe_session_id, amount_jpy, status) values ('sess_B', 500, 'completed');
select apply_paid_listing('yado-b', 'Yado B', 'Kyoto', 500, 'sess_B', '', '');
select slug, total_paid_jpy from listings order by total_paid_jpy desc;
\echo 'EXPECT: yado-b = 501, yado-a = 500 — never equal'

\echo ''
\echo '--- 4. A second, different payment tops the same listing up ---'
insert into payments (stripe_session_id, amount_jpy, status) values ('sess_C', 200, 'completed');
select apply_paid_listing('yado-a', 'Yado A', 'Nagano', 200, 'sess_C', '', '');
select slug, total_paid_jpy from listings order by total_paid_jpy desc;
\echo 'EXPECT: yado-a = 700 (500 + 200), now above yado-b'

\echo ''
\echo '--- 5. A run of taken totals is skipped until a free one is found ---'
insert into payments (stripe_session_id, amount_jpy, status) values ('sess_D', 700, 'completed');
select apply_paid_listing('yado-d', 'Yado D', 'Osaka', 700, 'sess_D', '', '');
select slug, total_paid_jpy from listings order by total_paid_jpy desc;
\echo 'EXPECT: yado-d = 701 (700 taken by yado-a, 701 free)'

\echo ''
\echo '--- 6. The no-tie rule is enforced by Postgres, not by the function ---'
\echo 'EXPECT: the next statement FAILS with a unique constraint violation'
insert into listings (slug, name, total_paid_jpy) values ('cheat', 'Cheat', 700);

\echo ''
\echo '--- 7. A payment with no recorded row is refused, not applied blindly ---'
\echo 'EXPECT: the next statement FAILS — without that row a retry could double it'
select apply_paid_listing('ghost', 'Ghost', 'X', 9999, 'no_such_session', '', '');
select count(*) as listings_unchanged from listings;
\echo 'EXPECT: still 3 listings (yado-a, yado-b, yado-d) — ghost was not created'

\echo ''
\echo '--- 8. Payments are linked back to their listing ---'
select p.stripe_session_id, p.status, l.slug
  from payments p left join listings l on l.id = p.listing_id
  order by p.stripe_session_id;
\echo 'EXPECT: every session completed and linked to its listing'
