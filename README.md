# Rajeev AI — V1 through V7

Browser-based realtime voice conversation with Rajeev, built on WebRTC and
the OpenAI Realtime API, extended through the full roadmap:

```
V1 — Voice
 → V2 — Memory (real accounts, dedup/contradiction handling)
 → V3 — Rajeev Methodology (FK Expansion Readiness Score, encoded)
 → V4 — Business Advisor (the methodology, scored and surfaced)
 → V5 — Project/Action Manager
 → V6 — AI Agents (governed, not autonomous)
 → V7 — Multi-company / white-label
```

**Read this before assuming anything below is "done" in the way a
shipped product is done.** Each version is real, working code — it
builds clean and every new endpoint is tested against expected
responses. None of it has run against a live Supabase project or a real
voice call, because this was built in a sandbox that can't reach
`api.openai.com` or `*.supabase.co`. The gap between "the code is
correct" and "this has been used" is real and is yours to close with
`npm run dev` and actual keys.

## Setup

1. Copy `.env.example` to `.env.local`, add your OpenAI key.
2. Create a Supabase project, run `supabase/schema.sql` in its SQL
   editor (safe to run once, covers V1 through V7 in one file).
3. Add `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` (server-side memory,
   methodology, projects, agents — all of it) and
   `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` (V2 sign-in,
   safe to expose).
4. In Supabase Auth settings, enable email OTP / magic link sign-in
   (on by default on a new project).
5. `npm install && npm run dev`.

**Every layer degrades independently.** No `NEXT_PUBLIC_SUPABASE_*` →
no sign-in screen, falls back to the old anonymous-browser identity. No
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` → voice still works, nothing
is remembered, V3-V7 panels just don't populate. This was a deliberate
choice from V1 onward and it still holds at V7.

## V2 — Memory: real accounts + dedup

- Sign-in is Supabase Auth magic link (`lib/supabaseBrowser.ts`,
  `app/page.tsx`'s auth gate). `people.auth_user_id` replaces the V1
  localStorage UUID as the actual identity.
- **Dedup/contradiction handling**: every extracted fact now carries a
  `fact_key` (a topic slug, e.g. `primary_business`). A new fact with
  the same key marks the old one `superseded` instead of piling up
  beside it — see `endConversationAndExtract` in `lib/memory.ts`. This
  was the specific V1 limitation called out as a named gap; it's closed.
- Row-Level Security is defined in `schema.sql` for every table, scoped
  to `auth.uid()`. The server uses the service-role key today and
  bypasses it — these policies matter the day anything queries Supabase
  directly from a signed-in browser session instead of through this
  server.

## V3/V4 — Rajeev Methodology / Business Advisor

This is **not invented content.** `lib/methodology.ts` encodes the FK
Expansion Readiness Score already used elsewhere on real work (the
Perfume Wala assessment scored 73 → "Expansion Ready") — seven
dimensions (commercial attractiveness, operational organization,
differentiation, financial clarity, systemization, founder
independence, technology readiness), each 0-100, tiered at 70/40. The
realtime session's instructions carry a compact briefing of this
framework plus the APC control chain (Product → Bill → Price → Money →
Movement, escalating Incident → Alert → Investigation → Audit Trail) so
Rajeev reasons with real structure, without turning calls into an audit.

**Scoping decision, stated plainly**: assessment happens via the same
post-call text-extraction pass as memory facts, not via a live
function-call inside the realtime session. OpenAI's Realtime API does
support live tool-calling, but wiring it in adds a second, more
fragile protocol surface (`response.function_call_arguments`,
`conversation.item.create` with `function_call_output`, etc.) that this
sandbox has no way to test end-to-end. Post-call extraction reuses the
one pattern already verified to work. Live tool-calling for the
assessment is a reasonable V8-scale upgrade, not a missed requirement.

Surfaced in the UI as a "Business Advisor" line in the collapsible
panel; full history is queryable via `GET /api/methodology/assess`.

## V5 — Project / Action Manager

- `projects` and `action_items` tables. The same end-of-call extraction
  pass pulls commitments/next steps out of the transcript, matches them
  to a project by name if one was mentioned, creates the project if not.
- Open items feed back into the *next* session's instructions
  (`lib/memory.ts`'s `contextForPrompt`) — "how did X go?" instead of a
  cold restart. This is what makes "continue from where we left off"
  real for tasks, not just facts.
- `GET/PATCH /api/projects` — list, mark done. Surfaced in the panel.

## V6 — AI Agents (governed, not autonomous)

`lib/agents.ts` mirrors the FK AIOS agent set already envisioned
elsewhere: **Sales, Finance, Ops, Inventory, Procurement, HR,
Strategy**. Every one of these can only *propose* — `agent_actions` is
simultaneously the queue and the audit trail (`created_at`,
`decided_at`, `decided_by`). Nothing executes without an explicit
`approved` decision through `POST /api/agents/actions/:id/decide`.

**One real, working trigger exists end to end**: if a business
assessment scores systemization below 50, the Strategy agent
automatically proposes drafting an SOP outline — sitting in the queue
for approval, visible in the panel. That's the whole governance loop,
demonstrated for real, once.

**Execution is now real, generically**: `POST
/api/agents/actions/:id/execute` (a separate step from approval, on
purpose — approving is a human decision, executing is the system
attempting to act on it, and those shouldn't be the same click) POSTs
the approved action's full payload to a webhook URL configured per
agent (`AGENT_WEBHOOK_URL_STRATEGY`, etc., falling back to a shared
`AGENT_WEBHOOK_URL`). On success the row moves to `executed`
(`executed_at` recorded); on failure or no webhook configured it moves
to `execution_failed` with the reason in `last_error`, and the panel
offers Retry. That's the honest boundary: this dispatches to whatever
you point it at — Zapier, Make, n8n, a custom endpoint — because
picking a specific vendor (Tally, a named CRM) without your
credentials would mean building against an integration I can't verify
even compiles correctly. What the webhook receiver does with the
payload once it arrives is real integration work per agent domain, one
system at a time — same scoping note as before, just moved one layer
deeper.

## V7 — Multi-company / white-label

- `companies` table (name, brand name, primary color, logo) +
  `people.company_id`. `GET/POST /api/company` creates and fetches a
  tenant's branding config; `PATCH /api/person` is how a person actually
  joins one (create-by-name, or join-by-id for teammates).
- **Now actually wired end to end**: the person's company is fetched
  alongside their memory on page load and after every call. The eyebrow
  text becomes the company's `brand_name` instead of "Rajeev AI", every
  brass/gold accent in the UI (`--brand` CSS variable, applied via
  `color-mix()` for the gradients and glows so shades stay
  proportionate to whatever color a tenant picks, not just the flat
  hex) — and the realtime persona's own instructions use the brand name
  too, so Rajeev introduces himself as the tenant's brand, not "Rajeev
  AI V1," once a company is attached.
- The panel has a real "Company" section: create one, see its
  shareable id, or join an existing one by pasting that id. No invite
  links or per-seat roles — that's genuinely further scope, not this
  pass's ask.

## Architecture

```
YOU
 │
 ▼
🎙️ Microphone ──WebRTC──▶ OpenAI Realtime API (barge-in, transcription)
 │                            │
 │  ◀── audio + live transcript + interruption truncation ──┘
 ▼
Browser: orb, captions, auth gate, business/agents panel
 │
 ▼ on call end
/api/memory/extract ──▶ one structured extraction pass ──▶
    facts (deduped)  +  action items  +  business assessment
                                              │
                                              ▼
                                    Strategy agent may PROPOSE
                                    (never executes unapproved)
 │
 ▼ next call
/api/realtime reads memory + open items + methodology briefing back in
```

## FKAIOS Brain bridge (optional, read-only)

Rajeev AI has its own Supabase project and memory (V2 above) — that is
unchanged and stays the primary store. `lib/fkaiosBrain.ts` additionally
pulls what the separate FKAIOS Brain (the `fkaios-aura-blueprint1` repo's
`founder-objective` edge function, `nrlsqshkjuuwiovthrnb`) already knows
about the person's company, so Rajeev doesn't start cold on something
FKAIOS has already worked on. It is called once per `getOrCreatePerson()`
(wired in at the end of that function in `lib/memory.ts`) and its result is
appended to `contextForPrompt` alongside the existing summary/open-items
context.

Three env vars gate it (`FKAIOS_FOUNDER_OBJECTIVE_URL`,
`FKAIOS_SUPABASE_ANON_KEY`, `FKAIOS_SERVICE_TOKEN` — see `.env.example`);
any missing one degrades to a no-op, same pattern as every other layer in
this app. On the FKAIOS side, the service token unlocks the `brain_context`
read action only — this app can never submit or rerun an FKAIOS objective
through it, and the platform's own JWT check on that endpoint is untouched
(the anon key satisfies it; the service token is a second, separate header).

**Not yet live**: as of this writing FKAIOS's own deploy of the updated
`founder-objective` function and the `FKAIOS_SERVICE_TOKEN` secret are both
still pending on the FKAIOS side — this bridge is written and wired but has
not been exercised against a live FKAIOS Brain.

## Setup files

- `supabase/schema.sql` — full V1-V7 schema, RLS policies included.
- `lib/memory.ts` — V1/V2/V5/V6 orchestration (this is the file that
  changed the most; read it top to bottom before extending it further).
- `lib/methodology.ts` — V3/V4 framework.
- `lib/agents.ts` — V6 agent registry + governance primitives.
- `lib/supabaseBrowser.ts` — V2 client-side auth.
- `lib/fkaiosBrain.ts` — optional read-only FKAIOS Brain bridge (above).

## What's verified vs. what needs a real browser + real keys + live Supabase

Verified here: clean `next build` + TypeScript pass across all 10 API
routes and the page; every new/changed endpoint hit with and without
Supabase configured, confirming correct status codes and response
shapes in both states; a labeling bug in `/api/agents/actions` found
and fixed during this pass (`configured: true` when nothing was
configured) — caught by testing rather than assumed correct.

Also caught and fixed in this pass: `PATCH /api/person` was checking
Supabase configuration before validating the request body, so a
malformed request with Supabase unconfigured returned a misleading
"Not configured" instead of the real "personId is required." Fixed to
validate input first. `POST /api/agents/actions/:id/execute` was
tested against the no-Supabase-configured path (correct 500) — the
actual webhook dispatch and the resulting `executed`/`execution_failed`
row transitions have not been run, since that needs a live Supabase
row and a real receiving endpoint, neither reachable here.

Not verified, because this sandbox can't reach `api.openai.com` or
`*.supabase.co`: an actual voice call, real barge-in feel, the
extraction pass actually calling a model and writing real rows, the
sign-in email actually arriving, RLS policies actually enforcing
anything, the Strategy agent's auto-proposal actually firing off a
real low-systemization score, and — new this pass — the white-label
theme actually rendering correctly across browsers for `color-mix()`
(broadly supported in current Chrome/Safari/Firefox as of this
writing, but genuinely untested here). All of the code paths for these
are written and internally consistent; none of them have been *run*.
`npm run dev` with real keys is where that gap closes.
