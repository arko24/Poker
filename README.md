# Telegram Hold'em — play-money poker Mini App

A Texas Hold'em poker game that runs inside Telegram as a [Mini App](https://core.telegram.org/bots/webapps). Play single-player against bots or create/join a multiplayer table by room code. Built with Next.js (App Router) + TypeScript on Vercel serverless, with Supabase Postgres as the single source of truth and Supabase Realtime for live table updates.

> **Play money only.** Coins in this game are virtual, have no real-world value, and cannot be bought, sold, deposited, or cashed out. There is no payment, deposit, withdrawal, or wagering of real currency anywhere in the app. This is a hobby game for fun — **it is not gambling.**

---

## Architecture at a glance

- **Server-authoritative.** All game state, betting, and balances live in Postgres. Clients only send intents (join, start, fold/call/raise) and render redacted snapshots; they never compute outcomes.
- **Pure engine.** The poker rules (card/hand evaluation, pots and side pots, the betting state machine, the bot) are pure, unit-tested TypeScript under `src/lib/server/engine/` and perform zero I/O.
- **Orchestrator.** `src/lib/server/orchestrator.ts` is the only place the engine, the database, and Realtime meet: load → validate → pure reducer → persist in one RPC → broadcast.
- **Node runtime.** API routes run on the Node.js runtime (not Edge) because they use Node `crypto` for the Telegram HMAC and the Supabase service-role client.
- **Liveness.** Turn timeouts are deadline-driven and enforced lazily. A per-minute GitHub Actions workflow POSTs to `/api/cron/tick` so hands never stall when every client disconnects (see [Liveness scheduler](#6-liveness-scheduler-github-actions-why-not-vercel-cron)).

---

## Prerequisites

- Node.js 18.18+ (the repo pins `engines.node >= 18.18.0`).
- A free [Supabase](https://supabase.com) account.
- A Telegram account (to talk to BotFather).
- A free [Vercel](https://vercel.com) account.
- A GitHub repository for this project (used for the liveness scheduler).

---

## 1. Create the Supabase project and apply migrations

1. In the [Supabase dashboard](https://supabase.com/dashboard), create a new project. Pick a strong database password and a region close to your players.
2. Wait for the project to finish provisioning.
3. Apply **both** migrations, in order. The files are in `supabase/migrations/`:
   - `0001_init.sql` — enums, tables (`users`, `rooms`, `seats`, `hands`, `hand_players`, `actions`, `hand_results`), constraints, the deferred circular FK, and Row Level Security enabled with **no** client policies (all access is via the server service-role key).
   - `0002_rpc.sql` — the transactional Postgres functions (`claim_topup`, `join_room`, `leave_room`, `start_hand`, `apply_action`, `complete_hand`) the server calls.

   **Option A — SQL editor (no tools to install):** open **SQL Editor → New query**, paste the full contents of `0001_init.sql`, run it, then repeat for `0002_rpc.sql`. Order matters: run `0001` before `0002`.

   **Option B — Supabase CLI:**
   ```bash
   npm i -g supabase          # or: brew install supabase/tap/supabase
   supabase login
   supabase link --project-ref <your-project-ref>
   supabase db push           # applies files under supabase/migrations in order
   ```

4. Collect these values from **Project Settings → API**:
   - **Project URL** → used for both `SUPABASE_URL` (server) and `NEXT_PUBLIC_SUPABASE_URL` (public).
   - **`anon` public key** → `NEXT_PUBLIC_SUPABASE_ANON_KEY` (public; used only to subscribe to Realtime).
   - **`service_role` secret key** → `SUPABASE_SERVICE_ROLE_KEY` (**server only**, full access, bypasses RLS — never expose it to the browser).

   Realtime Broadcast works out of the box; no extra toggle is required for the `room:{code}` channels this app uses.

---

## 2. Create the Telegram bot with BotFather

1. In Telegram, open a chat with [@BotFather](https://t.me/BotFather).
2. Send `/newbot`.
3. When prompted, enter a **display name** (e.g. `Holdem Fun`), then a **username** that must end in `bot` (e.g. `holdem_fun_bot`).
4. BotFather replies with an **HTTP API token** like `123456789:AA...`. Save it as `TELEGRAM_BOT_TOKEN` (**server only**). Treat it like a password.
5. Save the username (without the leading `@`) as `TELEGRAM_BOT_USERNAME`.

You will come back to configure the Mini App URL **after** you have a deployed URL (see step 5). You can set a placeholder now and point it at your real deployment later.

---

## 3. Map every environment variable

Copy `.env.example` to `.env.local` for local development and fill in real values. The table below shows where each variable lives. **Server-only** variables must never carry a `NEXT_PUBLIC_` prefix and are never imported into client code.

| Variable | Scope | Local (`.env.local`) | Vercel project env | GitHub Actions |
|---|---|:--:|:--:|:--:|
| `TELEGRAM_BOT_TOKEN` | server-only secret | ✅ | ✅ | — |
| `TELEGRAM_BOT_USERNAME` | server-only | ✅ | ✅ | — |
| `SUPABASE_URL` | server-only | ✅ | ✅ | — |
| `SUPABASE_SERVICE_ROLE_KEY` | server-only secret | ✅ | ✅ | — |
| `SESSION_SECRET` | server-only secret | ✅ | ✅ | — |
| `CRON_SECRET` | server-only secret | ✅ | ✅ | ✅ (secret) |
| `MINI_APP_URL` | server-only | ✅ | ✅ | ✅ (variable) |
| `NEXT_PUBLIC_SUPABASE_URL` | public (client-visible) | ✅ | ✅ | — |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public (client-visible) | ✅ | ✅ | — |

Notes:
- Only the two `NEXT_PUBLIC_*` variables reach the browser bundle. Everything else is read from `process.env` on the server (under `src/lib/server/`) only.
- `SESSION_SECRET` signs the short-lived (24h) session token issued by `/api/auth`. Use a long random string (32+ chars).
- `CRON_SECRET` is the shared secret the GitHub Actions scheduler presents to `/api/cron/tick`. The value in the GitHub secret **must match** the value in Vercel.
- `MINI_APP_URL` is your deployed base URL (e.g. `https://your-app.vercel.app`). The GitHub workflow uses it to build the tick URL.

Generate strong secrets, for example:
```bash
# any of these works for SESSION_SECRET / CRON_SECRET
openssl rand -hex 32
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

---

## 4. Run locally

```bash
npm install
npm run dev
```

The dev server starts on `http://localhost:3000`.

A browser opened directly at `localhost:3000` is **not** inside Telegram, so `window.Telegram.WebApp.initData` is empty and the app will show a "reopen from Telegram" prompt rather than authenticating — this is expected. The client code degrades gracefully outside Telegram. To exercise the real flow, deploy (step 5) and open the Mini App from inside Telegram.

Useful scripts:

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run build` | production build |
| `npm run start` | serve the production build |
| `npm run test` | run the Vitest unit suites once |
| `npm run typecheck` | `tsc --noEmit` |

---

## 5. Deploy to Vercel and point Telegram at it

1. Push this repository to GitHub.
2. In Vercel, **Add New → Project** and import the repo. Vercel auto-detects Next.js; no custom build command is needed.
3. Add every environment variable from the table above to **Settings → Environment Variables** (Production, and Preview if you use it). This is the server + public set — do **not** add the GitHub-only rows here beyond what's listed (both `CRON_SECRET` and `MINI_APP_URL` also belong in Vercel).
4. Deploy. Note the resulting URL, e.g. `https://your-app.vercel.app`.
5. Set `MINI_APP_URL` (and both `NEXT_PUBLIC_SUPABASE_URL` if not already) to the real deployment URL and redeploy if you used a placeholder.
6. **Point the Telegram Mini App at the deployment.** In [@BotFather](https://t.me/BotFather):
   - To set a menu button that opens the app: send `/setmenubutton`, pick your bot, send the deployed URL (`https://your-app.vercel.app`), then a button label (e.g. `Play`).
   - Alternatively configure it under **BotFather → your bot → Bot Settings → Menu Button / Web App**, pasting the same URL.
   - Players open the bot in Telegram and tap the menu button to launch the Mini App. (Telegram requires the Web App URL to be HTTPS — the Vercel URL already is.)
7. The `vercel.json` in the repo pins the API routes to the Node.js runtime (`nodejs20.x`) and intentionally contains **no** cron entry; liveness is handled by GitHub Actions (next section).

---

## 6. Liveness scheduler (GitHub Actions) — why not Vercel Cron

Serverless functions cannot run background timers, so a turn timeout is a **deadline** stored on the hand and enforced lazily: the next request (an action, an `/advance`, or a `/state` read) that sees `now() > act_deadline` auto-folds or auto-checks the stalled seat and progresses. That works as long as at least one client keeps making requests. If **every** human client closes the app mid-hand, nothing triggers the advance and the hand would stall.

`.github/workflows/tick.yml` closes that gap. It runs on `schedule: cron "* * * * *"` (every minute) and makes a single authenticated `POST` to `${MINI_APP_URL}/api/cron/tick` with the `CRON_SECRET` sent in the `x-cron-secret` header. The handler selects `in_hand` rooms whose `act_deadline` has passed and advances them (resolve timeout → run any bot turns → progress), guarded by the same optimistic fingerprint as every other advance, so it is safe to run concurrently with a client.

**Why not Vercel Cron:** this project targets the free tier. The Vercel **Hobby (free) plan does not run per-minute cron jobs** — Hobby cron granularity is effectively once per day, so a `* * * * *` schedule in `vercel.json` would be silently ignored and the "advance within ~1 minute" guarantee would not hold. GitHub Actions scheduled workflows run the per-minute cadence for free, need no third-party signup, and live in this same repo. (If you later upgrade to Vercel Pro, a `vercel.json` cron pointing at the identical `/api/cron/tick` handler is a drop-in replacement — you can then delete this workflow.)

GitHub's scheduler is **best-effort** and can be delayed by a few minutes under load. For a play-money hobby game that latency is acceptable: a stalled seat is resolved on the next tick rather than instantly.

### Configure the scheduler

In your GitHub repository, go to **Settings → Secrets and variables → Actions** and add:

- **Secrets → New repository secret:** `CRON_SECRET` — the exact same value set in Vercel.
- **Variables → New repository variable:** `MINI_APP_URL` — your deployed base URL, e.g. `https://your-app.vercel.app`.

The workflow reads `secrets.CRON_SECRET` and `vars.MINI_APP_URL`. You can trigger a manual run from the **Actions** tab (`liveness-tick → Run workflow`) to verify it returns `HTTP 200` with a body like `{"advanced":0}`.

**Alternatives** (all drive the identical `/api/cron/tick` endpoint — only the sender differs): a free uptime pinger such as cron-job.org hitting the same URL with the `x-cron-secret` header, or Supabase `pg_cron` + `pg_net`, or a Supabase Scheduled Edge Function.

---

## Daily top-up (where coins come from)

New players receive a starting coin bonus, and a **daily top-up** lets a low-balance player claim more once per 24 hours (guarded server-side on `coin_balance <= 100` and a 24h cooldown). These are the only ways coins enter an account — there is no purchase path. This keeps the game purely recreational.

---

## Project layout

```
src/app/                     Next.js App Router: layout, page, and api/* route handlers
src/app/api/                 auth, economy/claim, cron/tick, rooms + rooms/[code]/* endpoints (Node runtime)
src/lib/server/engine/       PURE poker engine (cards, handEval, pots, betting, handState, bot) — no I/O
src/lib/server/              supabaseAdmin, auth/, repo/, orchestrator, realtime/ (the impure layer)
src/lib/client/              telegram SDK wrapper, anon Realtime client, typed api fetch helpers
src/components/              Table, Seat, Board, Controls, BalanceBadge, Lobby, PlayMoneyNotice, PlayShell
src/types/                   shared redacted snapshot DTOs
supabase/migrations/         0001_init.sql (schema), 0002_rpc.sql (transactional functions)
.github/workflows/tick.yml   per-minute liveness scheduler -> POST /api/cron/tick
tests/                       Vitest unit suites
```

---

## Verification

```bash
npm run build       # Next.js production build
npm run test        # Vitest unit suites (engine, initData, single-player integration)
npm run typecheck   # tsc --noEmit
```

Live Telegram HMAC validation (against a real bot token), Supabase Realtime latency, and the Vercel deploy itself cannot be automated without credentials and are manual steps covered above.
