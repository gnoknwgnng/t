-- PostCraft AI: content-quality upgrade
-- Run once in the Supabase SQL Editor (SQL Editor -> New query -> Run).
-- Safe to run again: everything uses "if not exists" / "or replace".
--
-- Nothing here changes existing tables. The per-post details (structure,
-- opening, link placement, quality score and the results you type in) are
-- stored in the existing queue_items.metadata JSON column, so posts made
-- before this upgrade are untouched.

-- 1. Research Playbook: one row per research run, newest is the one in use.
create table if not exists public.playbooks (
  id text primary key,                       -- e.g. pb_20261128093000
  created_at timestamptz not null default now(),
  playbook jsonb not null,                   -- rules, policies, sources, confidence
  changes jsonb not null default '[]'::jsonb -- what differed from the previous one
);

create index if not exists playbooks_created_at_idx on public.playbooks (created_at desc);

-- Same access model as the other PostCraft tables (server key only).
alter table public.playbooks disable row level security;

-- 2. One row per published post, with the fields worth comparing.
create or replace view public.post_performance as
select
  q.id,
  q.user_id,
  q.published_at,
  q.metadata ->> 'topic'                         as topic,
  q.metadata ->> 'structure'                     as structure,
  q.metadata ->> 'hookType'                      as hook_type,
  q.metadata ->> 'linkMode'                      as link_mode,
  (q.metadata ->> 'hashtagCount')::int           as hashtag_count,
  (q.metadata ->> 'qualityScore')::numeric       as quality_score,
  (q.metadata -> 'metrics' ->> 'impressions')::int as impressions,
  (q.metadata -> 'metrics' ->> 'reactions')::int   as reactions,
  (q.metadata -> 'metrics' ->> 'comments')::int    as comments,
  (q.metadata -> 'metrics' ->> 'saves')::int       as saves,
  (q.metadata -> 'metrics' ->> 'reposts')::int     as reposts,
  q.metadata ->> 'articleTitle'                  as article_title
from public.queue_items q
where q.status = 'published';

-- 3. The comparison: which structure / opening / link placement does best.
--    Only posts with impressions filled in are counted.
create or replace view public.post_performance_summary as
with measured as (
  select * from public.post_performance where impressions is not null and impressions > 0
),
unpivoted as (
  select user_id, 'structure' as dimension, structure as value, impressions, reactions, comments, saves, reposts from measured
  union all
  select user_id, 'hook_type', hook_type, impressions, reactions, comments, saves, reposts from measured
  union all
  select user_id, 'link_mode', link_mode, impressions, reactions, comments, saves, reposts from measured
)
select
  user_id,
  dimension,
  coalesce(value, 'unknown')                                   as value,
  count(*)                                                     as posts,
  round(avg(impressions))                                      as avg_impressions,
  round(
    100.0 * sum(coalesce(reactions, 0) + coalesce(comments, 0) + coalesce(saves, 0) + coalesce(reposts, 0))
    / nullif(sum(impressions), 0), 2
  )                                                            as engagement_rate_pct
from unpivoted
group by user_id, dimension, coalesce(value, 'unknown')
order by user_id, dimension, avg_impressions desc;
