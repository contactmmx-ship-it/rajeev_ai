-- Rajeev AI — full schema, V1 through V7.
-- Run this once in the Supabase SQL editor. Safe to re-run (IF NOT EXISTS
-- throughout) when adding V2-V7 to an existing V1 database.

create extension if not exists "pgcrypto";

-- ============================================================
-- V7 — Companies (multi-tenant / white-label)
-- Created before people because people references it.
-- ============================================================
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  brand_name text not null default 'Rajeev AI',
  primary_color text not null default '#c9a84c',
  logo_url text,
  created_at timestamptz not null default now()
);

-- ============================================================
-- V1/V2 — People
-- V2 adds auth_user_id (real accounts, replacing the localStorage UUID).
-- V7 adds company_id (which tenant this person belongs to, if any).
-- ============================================================
create table if not exists people (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid unique references auth.users(id) on delete set null,
  company_id uuid references companies(id) on delete set null,
  name text,
  summary text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  started_at timestamptz not null default now(),
  ended_at timestamptz,
  transcript jsonb not null default '[]'::jsonb
);

-- V2: fact_key + status turn this from append-only into something that
-- can be corrected. Same fact_key + person_id + active status = the new
-- fact supersedes the old one instead of piling up beside it.
create table if not exists memory_facts (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  category text not null check (
    category in ('identity','business','goal','decision','project','constraint','preference','fact')
  ),
  fact_key text not null,
  content text not null,
  status text not null default 'active' check (status in ('active','superseded')),
  created_at timestamptz not null default now()
);

create index if not exists idx_conversations_person on conversations(person_id);
create index if not exists idx_memory_facts_person_key on memory_facts(person_id, fact_key, status);

-- ============================================================
-- V5 — Project / Action Manager
-- ============================================================
create table if not exists projects (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  name text not null,
  status text not null default 'active' check (status in ('active','done','dropped')),
  created_at timestamptz not null default now()
);

create table if not exists action_items (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  project_id uuid references projects(id) on delete set null,
  conversation_id uuid references conversations(id) on delete set null,
  description text not null,
  status text not null default 'open' check (status in ('open','done','dropped')),
  created_at timestamptz not null default now()
);

create index if not exists idx_action_items_person_status on action_items(person_id, status);

-- ============================================================
-- V3/V4 — Rajeev Methodology / Business Advisor
-- The 7 dimensions and tiers mirror the FK Expansion Readiness Score
-- already used elsewhere (e.g. the Perfume Wala assessment). Each
-- dimension is scored 0-100 where higher is always better — including
-- founder_independence, deliberately named so a high score reads the
-- same direction as every other dimension.
-- ============================================================
create table if not exists business_assessments (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  conversation_id uuid references conversations(id) on delete set null,
  commercial_attractiveness int not null check (commercial_attractiveness between 0 and 100),
  operational_organization int not null check (operational_organization between 0 and 100),
  differentiation int not null check (differentiation between 0 and 100),
  financial_clarity int not null check (financial_clarity between 0 and 100),
  systemization int not null check (systemization between 0 and 100),
  founder_independence int not null check (founder_independence between 0 and 100),
  technology_readiness int not null check (technology_readiness between 0 and 100),
  overall_score int not null check (overall_score between 0 and 100),
  tier text not null check (tier in ('Founder-Dependent','Needs Systemization','Expansion Ready')),
  created_at timestamptz not null default now()
);

create index if not exists idx_assessments_person on business_assessments(person_id, created_at desc);

-- ============================================================
-- V6 — AI Agents under a governance layer
-- Mirrors the FK AIOS agent set (Sales, Finance, Ops, Inventory,
-- Procurement, HR, Strategy). Agents PROPOSE actions; nothing executes
-- without a human decision — this table IS the approval + audit trail.
-- ============================================================
create table if not exists agent_actions (
  id uuid primary key default gen_random_uuid(),
  person_id uuid not null references people(id) on delete cascade,
  agent_name text not null check (
    agent_name in ('sales','finance','ops','inventory','procurement','hr','strategy')
  ),
  action_type text not null,
  description text not null,
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'proposed' check (
    status in ('proposed','approved','rejected','executed','execution_failed')
  ),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by text,
  executed_at timestamptz,
  last_error text
);

-- Safe to re-run against a database created before execution tracking
-- existed: adds the new status option and columns without touching data.
alter table agent_actions drop constraint if exists agent_actions_status_check;
alter table agent_actions add constraint agent_actions_status_check
  check (status in ('proposed','approved','rejected','executed','execution_failed'));
alter table agent_actions add column if not exists executed_at timestamptz;
alter table agent_actions add column if not exists last_error text;

create index if not exists idx_agent_actions_person_status on agent_actions(person_id, status);

-- ============================================================
-- Row-Level Security
-- The server uses the service-role key today, which bypasses RLS
-- entirely — these policies are defense-in-depth for when/if any
-- client ever queries Supabase directly with a user's own session.
-- ============================================================
alter table people enable row level security;
alter table conversations enable row level security;
alter table memory_facts enable row level security;
alter table projects enable row level security;
alter table action_items enable row level security;
alter table business_assessments enable row level security;
alter table agent_actions enable row level security;

drop policy if exists "own person row" on people;
create policy "own person row" on people
  for all using (auth_user_id = auth.uid());

drop policy if exists "own conversations" on conversations;
create policy "own conversations" on conversations
  for all using (person_id in (select id from people where auth_user_id = auth.uid()));

drop policy if exists "own memory facts" on memory_facts;
create policy "own memory facts" on memory_facts
  for all using (person_id in (select id from people where auth_user_id = auth.uid()));

drop policy if exists "own projects" on projects;
create policy "own projects" on projects
  for all using (person_id in (select id from people where auth_user_id = auth.uid()));

drop policy if exists "own action items" on action_items;
create policy "own action items" on action_items
  for all using (person_id in (select id from people where auth_user_id = auth.uid()));

drop policy if exists "own assessments" on business_assessments;
create policy "own assessments" on business_assessments
  for all using (person_id in (select id from people where auth_user_id = auth.uid()));

drop policy if exists "own agent actions" on agent_actions;
create policy "own agent actions" on agent_actions
  for all using (person_id in (select id from people where auth_user_id = auth.uid()));
