# twenty-outreach-research

Deep research + outreach drafting pipeline for Verlet GTM.

Reads a target list (universities, companies, individual researchers), produces a structured research brief and 2 email draft variants per target, and writes everything back to the Twenty CRM Person/Company records for human review. Approved drafts get pushed to Gmail as drafts.

## Architecture

See `/Users/mats2/.claude/plans/if-i-wanted-to-staged-sky.md` for the full design.

```
L1 Discover  →  L2 Research  →  L3 Draft  →  L4 CRM ingest  →  L5 Review  →  L6 Send
```

## Secrets

All keys live in Doppler — project `crm`, config `dev_verlet`. The Nx targets
below wrap every command with `doppler run` so you never need a local `.env`.
If you prefer `.env`, copy `.env.example`.

## Setup

```bash
cp .env.example .env
# Fill in keys

# Prereq: the legacy Notion → Twenty migration must be run once first.
# See /Users/mats2/Documents/GTM/migration/HANDOFF.md. That migration installs
# Company.accountType/country/dataNeed/notionPageUrl and the Opportunity stage
# funnel, and backfills ~53 companies + their People from the Notion DB.

# One-time: install the ADDITIONAL custom fields this pipeline needs on Person
# (researchStatus, emailDraftV1/V2/Final, judgeScore, judgeNotes, gmailDraftId,
# hookSummary) and on Company (researchSummary). Idempotent.
yarn nx run twenty-outreach-research:setup:install-fields

# One-time (UI tidy): split the cluttered Company list into four filtered table
# views by accountType — Companies (COMPANY), Labs & Institutions (LAB+INSTITUTION),
# Investors (INVESTOR), Misc (MISC). Idempotent. After running, favorite each view
# in Twenty (hover the view tab → ☆) to pin it as its own left-sidebar entry.
yarn nx run twenty-outreach-research:setup:install-company-views

# Smoke test: confirm Twenty connection works
yarn nx run twenty-outreach-research:smoke:client

# Smoke test: run the full L2+L3 pipeline against the bundled UT Austin fixture
# (no scrapers, no CRM writes — just shows you what a brief + 2 drafts look like)
yarn nx run twenty-outreach-research:smoke:pipeline

# Smoke test: just the scrapers (no LLM cost) — verifies EXA / FIRECRAWL /
# Semantic Scholar keys are working and shows raw research inputs.
yarn nx run twenty-outreach-research:smoke:gather -- \
  --target "Yuke Zhu" --affiliation "UT Austin" \
  --lab https://rpl.cs.utexas.edu/ --twitter yukez

# LIVE pipeline (scrapers + LLM): research a target end-to-end and print
# the brief + two email drafts. Does NOT write to the CRM.
yarn nx run twenty-outreach-research:smoke:pipeline -- \
  --target "Yuke Zhu" --affiliation "UT Austin" \
  --lab https://rpl.cs.utexas.edu/ --twitter yukez --role professor
```

## Qualification / fit gate

Not every contact is worth running the (paid) research pipeline on. The bar is
**academic-lenient, company-strict**:

- **Academic** (lab / institution): keep faculty/PIs **and** researchers (PhD,
  postdoc, research scientist/fellow). Drop undergrads + interns.
- **Company**: keep **only** leadership (Head/Director/VP/C-level/Founder/Manager,
  plus "Founding X"). Drop individual contributors (engineers, scientists).
- **Investors** (`Company.accountType = INVESTOR`): never research — different
  GTM motion. Kept in the CRM, excluded from the pipeline.

Two pieces enforce this:

1. **`researchGate()`** (`src/qualify/should-research.ts`) runs inside
   `run-pending` and `enqueue-research`. It silently skips investors + obvious
   poor-fit roles before any credits are spent. Rule-based, no API cost;
   ambiguous contacts always pass through. This is a guardrail — it never
   deletes anything.

2. **`qualify-contacts`** — a one-off / recurring pass that soft-deletes
   poor-fit *roles* from the CRM entirely. Safe by default: a plain run is a dry
   run that prints exactly who'd be cut and why. Deletion is opt-in, soft
   (recoverable in Twenty's deleted-records view), and never touches anyone past
   `NEEDS_RESEARCH`. Uncertain cases are always kept.

```bash
# Pure-logic smoke test for the classifier (no API, no cost)
yarn nx run twenty-outreach-research:smoke:qualify

# Dry run — report who'd be cut, change nothing
yarn nx run twenty-outreach-research:qualify:contacts

# Dry run + free LLM tie-break (NIM Llama) on ambiguous titles
yarn nx run twenty-outreach-research:qualify:contacts -- --llm

# Apply — soft-delete the poor-fit contacts
yarn nx run twenty-outreach-research:qualify:contacts -- --delete
```

The classifier is title-driven; contacts with **no job title** are always kept
and surfaced as "review" (the CRM is currently title-sparse — most migrated
rows have no title, so they can't be auto-judged).

### Title backfill

Because the bar is title-driven, missing titles are the real bottleneck.
`backfill-titles.ts` fills `Person.jobTitle` so the classifier can judge a
contact. Two segments, dispatched by `Company.accountType`:

- **Commercial** (COMPANY/MISC): Apollo `/people/match` by name + employer
  domain → title; Hunter `position` as a fallback. ~1 Apollo credit each.
- **Academic** (LAB/INSTITUTION): Exa web search + a grounded free-NIM
  extractor (writes a title only when one is explicitly stated in the snippets).

Investors are skipped (the gate drops them anyway). **Credit-safe by default**:
a plain run is *scope mode* — lists targets + estimated credit cost, makes no
API calls. `--apply` performs the lookups and writes. `jobTitle` is only
written when found AND currently empty (never clobbered); after writing it
reports which contacts the fit bar would now drop (it does **not** delete them).

```bash
# Scope only — who'd be enriched + estimated cost, no API calls
yarn nx run twenty-outreach-research:qualify:backfill-titles

# Apply — query Apollo/Exa and write titles
yarn nx run twenty-outreach-research:qualify:backfill-titles -- --apply

# Just one segment, or skip Hunter
yarn nx run twenty-outreach-research:qualify:backfill-titles -- --apply --segment commercial --no-hunter
```

## Production loop

The pipeline produces a **research brief** + a **selling-angles brainstorm**
per target. It does NOT write the email — Mateo does, using the brainstorm
as substrate.

```bash
# Run for ONE Person already in the CRM. Writes brief as Note 1, brainstorm
# as Note 2, sets hookSummary to the top angle, flips researchStatus
# NEEDS_RESEARCH → RESEARCHING → RESEARCH_DONE → DRAFTING → DRAFTED.
yarn nx run twenty-outreach-research:run:person -- --person-id <uuid>

# Same but no CRM writes — useful for previewing.
yarn nx run twenty-outreach-research:run:person -- --person-id <uuid> --dry-run

# Batch: find every Person with researchStatus=NEEDS_RESEARCH and process them.
yarn nx run twenty-outreach-research:run:pending -- --limit 10

# Dump the brief + brainstorm for any Person from the terminal.
doppler run --project crm --config dev_verlet -- \
  npx tsx src/lib/inspect-person.ts <uuid>
```

## Trigger buttons in Twenty UI

Research can be kicked off from **buttons on Person and Company records** in the
Twenty UI — no need to drop to the terminal. This works **without forking
Twenty's code**: it uses Twenty's native *Workflows* feature pointed at this
package's HTTP trigger server.

### Architecture

```
[Person/Company record button]                (Twenty UI)
        │  manual-trigger workflow
        ▼
[HTTP Request action] ──POST──▶ [trigger server] ──enqueue──▶ [BullMQ/Redis]
                                  /triggers/*                       │
                                                                    ▼
                                                          [queue:worker] runs
                                                          runForPerson / runForCompany
```

The button returns instantly (the server only enqueues); the worker does the
slow LLM research out-of-band and writes results back to the CRM — same code
paths as `run:person` / `run-for-company`.

### 1. Run the trigger server + worker

Endpoints (bearer-token auth):

- `POST /triggers/research-person`  body `{ "personId": "<uuid>" }`
- `POST /triggers/research-company` body `{ "companyId": "<uuid>" }`
- `GET /health` (unauthenticated — for uptime checks)

Set `OUTREACH_TRIGGER_TOKEN` (generate with `openssl rand -hex 32`). Then either:

- **One process:** `yarn nx run twenty-outreach-research:serve` — runs the
  trigger server *and* the queue worker together. Simplest.
- **Two processes (recommended at scale):**
  `yarn nx run twenty-outreach-research:trigger:server` (web) +
  `yarn nx run twenty-outreach-research:queue:worker` (worker), sharing the same
  `REDIS_URL`.

### 2. Deploy on Railway

Point a Railway service at this package with start command
`yarn nx run twenty-outreach-research:serve` (single service) — or two services
using `trigger:server` and `queue:worker`. Provide the same env vars Doppler
supplies locally, plus `OUTREACH_TRIGGER_TOKEN`. Railway injects `PORT`; the
server reads it automatically. Note the public URL (e.g.
`https://outreach-trigger.up.railway.app`).

### 3. Create the buttons in Twenty (no code)

For each button, in the Twenty workspace UI:

1. **Settings → Workflows → New workflow.**
2. **Trigger:** **Manual trigger**, availability **single record**, object type
   **Person** (or **Company**). This makes it appear as a button on that
   record's page and in the command menu. Label it e.g. *"Research this Person"*
   and pick an icon.
3. **Add action → HTTP Request:**
   - **Method:** `POST`
   - **URL:** `https://<your-railway-url>/triggers/research-person`
     (or `/triggers/research-company`)
   - **Headers:** `Authorization: Bearer <OUTREACH_TRIGGER_TOKEN>` and
     `Content-Type: application/json`
   - **Body:** `{ "personId": "{{trigger.record.id}}" }`
     (Company: `{ "companyId": "{{trigger.record.id}}" }`) — use the workflow
     variable picker to insert the record id.
4. **Publish/activate** the workflow.

Repeat for the Company button. Clicking now enqueues research; watch the
`queue:worker` logs to see it run. Enqueues are idempotent per record id, so a
double-click won't double-research the same record. The server returns `400` if
the `{{trigger.record.id}}` variable didn't render — handy for catching a
mis-wired body in Twenty's workflow run history.

## Review loop (in Twenty UI)

1. Filter People by `researchStatus = DRAFTED`. The top-angle headline is
   visible on the Person row as `Hook`.
2. Open a Person — read the two latest Notes:
   - **"Research brief — Name"** — the concise factual summary.
   - **"Selling angles — Name"** — ranked angles + opener ideas + anti-angles
     + warm-intro paths.
3. Write the email yourself, paste into `Final Email (edited)`, flip
   `researchStatus = APPROVED`. (L6 — Gmail draft creation — fires next.)

The `Email Draft (short)` / `Email Draft (long)` custom fields are kept in the
schema for back-compat but the pipeline no longer populates them. The
`src/draft/` code is retained in-tree in case we want to revive automated
drafting later.

## Model routing

Every pipeline role (extractor / synthesizer / writer / critic / judge) has a
default model that you can override via env var using a `provider:model`
prefix. Six providers wired in:

| Prefix | Provider | Key env var |
|---|---|---|
| `anthropic:` | Anthropic | `ANTHROPIC_API_KEY` |
| `openai:` | OpenAI | `OPENAI_API_KEY` |
| `nvidia:` | NVIDIA NIM (free hosted Llama / Kimi K2 / etc.) | `NVIDIA_API_KEY` |
| `openrouter:` | OpenRouter (one key, every model) | `OPENROUTER_API_KEY` |
| `moonshot:` | Moonshot direct (Kimi) | `MOONSHOT_API_KEY` |
| `groq:` | Groq (fastest open-model inference) | `GROQ_API_KEY` |

Defaults: cheap roles on free NIM Llama, writer/critic on Claude Opus,
**judge on NIM-hosted Kimi K2** (different model family → genuinely
independent eyes, free). Override examples:

```bash
# Cost-max: run everything on Kimi K2 via NIM (free)
EXTRACTOR_MODEL=nvidia:meta/llama-3.3-70b-instruct
SYNTHESIZER_MODEL=nvidia:moonshotai/kimi-k2-instruct
WRITER_MODEL=nvidia:moonshotai/kimi-k2-instruct
CRITIC_MODEL=nvidia:moonshotai/kimi-k2-instruct
JUDGE_MODEL=anthropic:claude-opus-4-7

# A/B: keep Claude on the quality roles, swap judge to GPT-5
JUDGE_MODEL=openai:gpt-5
```

`printRouterConfig()` runs at the top of `smoke:pipeline` so you see which
model each role resolved to before any tokens are spent.

## Layout

```
src/
  lib/            shared infra (twenty client, LLM router, prompt cache)
  setup/          one-time setup scripts (custom fields, Notion import)
  discover/       L1 — find new targets
  research/       L2 — deep-research a known target
  draft/          L3 — generate email drafts + critique
  send/           L6 — Gmail draft + reply watcher
prompts/          versioned prompts (system, style guide, rubric)
```
