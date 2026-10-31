# Hub of Me

A personal reasoning system for one person. Judgment lives in the model. Code keeps the books: it validates, saves, versions, logs, queues, enforces the hard boundaries, and counts usage.

The soul is a slow, versioned document (values, direction, goals, the current strategy, and how the system thinks). Every role reads it. Only reflection, or an explicit correction by you, changes it. One chat message cannot.

## Stack

- **API:** Node 22, TypeScript, [Hono](https://hono.dev). One process serves the API and, in production, the built client.
- **Data:** Postgres. Set `DATABASE_URL` (Neon or Supabase free tier) in production. With no URL, the app uses [PGlite](https://pglite.dev), Postgres in-process, under `data/pglite`. Tests use a fresh in-memory database. The SQL is the same either way.
- **Web app:** React, Vite, Tailwind, and the usual primitives (button, input, dialog, tabs). Dark, with a yellow accent. It is a PWA: install it to a phone home screen from the browser. No app store.
- **Desktop:** Electron. The window loads the same web app, adds a global shortcut (Ctrl/Cmd+Shift+Space starts dictation), and can raise a notification. Context isolation is on and the page has no Node access.

Electron, not Tauri: the desktop program is a window onto this one web app. Electron opens that window from Node, which is already required to run the server, and packages it for Linux, macOS, and Windows. Tauri is smaller, but it needs a system WebKit and a Rust build of the shell. The hard boundaries live in the server, not in the window.

- **Models:** one adapter. Anthropic is first, Gemini is second, and a mock provider runs the whole path with no key. Chat and filing use the cheap model. Reflection, the critic, and debates use stronger ones. The judge model is never one of the debaters. Prices are published list prices applied to token counts the provider returned. The app does not estimate tokens.

## What works with the mock provider

Sign in, dump text, voice recording (transcription uses the browser's speech recognition; the recording is stored and the server does not invent words), filing into typed notes, versions and undo, the for-now bin, nightly archive (never delete), the soul and its history, a debate with an uncomfortable side, an anonymised judge, a commitment or a send-back, predictions, info cards, a brief, a discovery deck, bookmarks, PDF and Word import, Word export, an in-app calendar the system may write, an action log, a health ledger, a €20 monthly cap, and a read-only Gmail scaffold.

## What is stubbed

- Gmail can start OAuth with the `gmail.readonly` scope only. Token exchange is wired. Listing messages returns a not-linked or scaffold response. There is no send function and no send route. No Drive, no Photos.
- Web search runs only when `SEARCH_ENABLED=true`, and only after a query passes the privacy guard. Otherwise research stores the sources the model named.
- Google Calendar is not connected. The calendar inside the app is real, and the system may write to it.
- Finances, relationships, and mobility are not built. The module row is the place they plug in later.
- The mock filer stores the dump as one note and always flags it, so you can watch the whole path. A real model decides type, folder, and whether it matters.

## Run it here

```bash
npm install
cp .env.example .env   # optional; the defaults below already work
npm test
npm run dev
```

Open [http://127.0.0.1:43123](http://127.0.0.1:43123).

Default local account, from `.env.example`:

- email `peter@local`
- password `hub-of-me`

Change `USER_PASSWORD` before anyone else can reach the machine. The first start creates the account. After that, every start updates that same account when both `USER_EMAIL` and `USER_PASSWORD` are set: email, password, and `USER_NAME` when that is set. The account id does not change, so notes stay linked. A password changed in Settings works immediately. If `USER_PASSWORD` is set, the next start writes that value again. Leave `USER_PASSWORD` unset when the Settings password should survive a restart.

The dev API listens on port 43124. Vite on 43123 proxies `/api` to it.

### Desktop window

With `npm run dev` already running:

```bash
npm run desktop
```

Ctrl/Cmd+Shift+Space focuses the window and starts dictation. To point the shell at a hosted app, set `HUB_URL`.

A packaged shell (the current OS only):

```bash
npm run desktop:pack
```

Output lands in `desktop-dist/`. The packaged window still needs the server, local or hosted.

### Phone

Production is served over HTTPS. In the phone browser, use Add to Home Screen. The manifest and service worker are part of the Vite build. API calls are not cached.

## Add a model key

Keys are environment variables. They are never written into the repo or sent to the browser.

```bash
# .env
AI_PROVIDER=anthropic
ANTHROPIC_API_KEY=sk-ant-...
```

Restart, sign in, and on Settings choose Anthropic. Defaults:

| Role | Model |
| --- | --- |
| Chat, filing, research, duties | `anthropic:claude-haiku-5-5` |
| Reflection, critic | `anthropic:claude-sonnet-5-5` |
| Judge | `anthropic:claude-sonnet-5-5` (not used as a debater) |
| Second debater, if `GEMINI_API_KEY` is set | `gemini:gemini-2.5-flash` |

If a model id is not in `src/prices.ts`, the call is refused. A cost is not invented. Add a list price under Settings only by extending `priceOverrides`, or add the model to `LIST_PRICES`.

Gemini on its own: `AI_PROVIDER=gemini` and `GEMINI_API_KEY`. Set the cheap and strong model fields to `gemini:gemini-2.5-flash` and `gemini:gemini-2.5-pro`, and keep the judge on a different id from the debaters.

List prices were taken on 31 Oct 2026 from [Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) and [Gemini](https://ai.google.dev/gemini-api/docs/pricing). The euro figure is those dollar prices times `USD_TO_EUR` (default `0.8959`, the rate that day). Change the rate when it moves. The cap defaults to €20 (`MONTHLY_CAP_EUR_CENTS=2000`). When the month's recorded spend reaches the cap, further calls stop.

## Tests

```bash
npm test
```

They cover the mock path (dump, filing, versions, debate, judge, soul update, usage taken from the provider response), hedge send-back, the uncomfortable side, anonymised judge order, boundary enforcement (no delete, no send, read-only Gmail, no private text in search, no signing in), the budget cap, for-now expiry, undo, Word import, startup sync of the single account from `USER_EMAIL` and `USER_PASSWORD`, and changing the password in Settings.

## Deploy

The app deploys from the GitHub repo [isaakvhs-png/hub-of-me](https://github.com/isaakvhs-png/hub-of-me), branch `main`. Neon holds Postgres. Render runs the free web service described in `render.yaml` (build `npm install && npm run build`, start `npm start`). That file lists the env var names and no values. Fill them in the Render dashboard. Do not commit secrets.

### 1. Postgres

1. Create a project at [neon.tech](https://neon.tech).
2. Copy the pooled connection string. That is `DATABASE_URL`.

### 2. Web service on Render

1. In Render, New Blueprint (or New Web Service) and connect [github.com/isaakvhs-png/hub-of-me](https://github.com/isaakvhs-png/hub-of-me), branch `main`.
2. `render.yaml` already sets a free Node web service, the build command, and the start command. If you create the service by hand instead, use build `npm install && npm run build` and start `npm start`.
3. Environment variables (names only; set the values in Render, not in git):

| Name | Value |
| --- | --- |
| `NODE_ENV` | `production` |
| `DATABASE_URL` | the Neon string |
| `SESSION_SECRET` | a long random string |
| `USER_EMAIL` | your email |
| `USER_PASSWORD` | a real password. On every start, when this and `USER_EMAIL` are both set, they replace the single account's email and password. Notes stay on that account. A password changed in Settings lasts only until the next start. |
| `USER_NAME` | Peter. Applied on that same start when set; otherwise the stored name stays. |
| `AI_PROVIDER` | `mock` until a key is set, then `anthropic` |
| `ANTHROPIC_API_KEY` | the key, or leave empty |
| `GEMINI_API_KEY` | optional |
| `USD_TO_EUR` | `0.8959` or today's rate |
| `MONTHLY_CAP_EUR_CENTS` | `2000` |
| `PUBLIC_URL` | the Render service URL, once it exists |
| `GOOGLE_CLIENT_ID` | only if you link Gmail |
| `GOOGLE_CLIENT_SECRET` | only if you link Gmail |
| `SEARCH_ENABLED` | `true` to allow web search after the privacy guard |

`npm start` sets `NODE_ENV=production` and listens on Render's `PORT`.

4. Open the service URL, sign in, and install the PWA from the browser menu.

The free Render instance sleeps when idle. The first request after that is slow. Data stays in Neon. Uploaded audio is on the instance disk (`data/recordings`) and does not survive a redeploy; the transcript does, because it is in Postgres.

### Fly.io, if you use that instead

```bash
fly launch --no-deploy
fly secrets set DATABASE_URL=... SESSION_SECRET=... USER_EMAIL=... USER_PASSWORD=... AI_PROVIDER=mock
fly deploy
```

Set the internal port to the same `HUB_PORT` the process binds.

## Hard boundaries, in code

- Sending email or any other outreach throws. Drafts are stored. Gmail's only scope is `gmail.readonly`, and a granted scope that is anything else is rejected.
- There is no delete. Cleanup archives. A test fails if `DELETE FROM` appears under `src/` or `server/`.
- A web search query that contains an email, a phone number, a password, or a stretch of text from a person note or a local category is refused whole. It is not rewritten and then sent.
- Actions named like signing in or entering a password throw.
- Writing the in-app calendar is allowed, and the reason is logged.

## Layout

```
src/            domain: boundaries, providers, filing, debate, usage
server/         HTTP, sessions, nightly timer
client/         PWA
desktop/        Electron shell
tests/          the pipeline and the boundaries
```
