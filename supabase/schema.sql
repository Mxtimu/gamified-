-- Ghost Puppy Game Studio: Supabase cloud backup schema.
-- Run once: Supabase dashboard -> SQL Editor -> paste -> Run.
--
-- Only anonymised data lives here. There is deliberately no callsign, phone,
-- PIN, device, session, raw text, exact location, or report -> agent link.
-- Row Level Security is ON with no policies: only the server's secret key can
-- read or write. The browser never talks to Supabase.

create table if not exists public.gp_agents (
  ghost_id    text primary key,
  avatar      text,
  rank        text,
  xp          integer not null default 0,
  coins       integer not null default 0,
  home_zone   text,
  joined_at   timestamptz,
  updated_at  timestamptz not null default now()
);

create table if not exists public.gp_reports (
  ref             text primary key,
  category        text not null,
  severity        smallint not null,
  status          text not null,
  zone            text,
  crew            text,
  landmark        text,
  lat_blurred     double precision,   -- snapped to a 150 m grid, never the real pin
  lng_blurred     double precision,
  precision_m     integer not null default 150,
  observed_window timestamptz,        -- rounded to 15 minutes
  description     text,               -- PII-scrubbed copy only
  photo_paths     text[] not null default '{}',  -- objects in the 'evidence' bucket
  coins_awarded   integer not null default 0,
  verified_by     text,
  verified_at     timestamptz,
  reactions       jsonb not null default '{}'::jsonb,
  comment_count   integer not null default 0,
  updated_at      timestamptz not null default now()
);

create table if not exists public.gp_comments (
  id          bigint primary key,     -- the local comment id
  report_ref  text not null references public.gp_reports(ref) on delete cascade,
  alias       text not null,          -- per-thread alias, e.g. Fox-3F2A
  is_reporter boolean not null default false,
  body        text not null,          -- PII-scrubbed
  created_at  timestamptz not null
);
create index if not exists gp_comments_report on public.gp_comments(report_ref, id);

alter table public.gp_agents   enable row level security;
alter table public.gp_reports  enable row level security;
alter table public.gp_comments enable row level security;

-- Private bucket for cleaned evidence photos (EXIF/GPS already destroyed).
insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false)
on conflict (id) do nothing;
