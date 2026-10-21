# aivu-backend

Backend of **AI Logic Assist**: it receives a snapshot of a home plan (and,
optionally, the builder's PDF) and answers with the operations that configure
its option logic: which options exclude each other, which depend on which,
renames, filters, elevation links.

It started as a proof of concept inside the `vu` monorepo (plan app +
Firebase functions). This repo is where it continues on its own.

## Layout

```
contract/            JSON Schemas of the contract (generated, committed)
packages/core/       @aivu/core  contract, rules, tools. Pure TypeScript.
packages/server/     @aivu/server  Cloudflare Worker: HTTP API, auth, Gemini
```

`@aivu/core` has no UI, no network and no model. Everything that decides is
there and is tested, the agent loop included; the server only moves data and
talks to Gemini.

## How an analysis works

```
snapshot  ->  deterministic baseline  ->  agent with tools  ->  operations
              (plan sheet + rules)        (runs on a copy)
```

1. The app sends a **snapshot** (options, floors, elevations, room names,
   optional plan sheet). No urls, no images, no user data.
2. `analyzeDeterministic` computes what needs no model: what the plan sheet
   says, then the rules (names, geometry, defaults, elevations).
3. An agent may add what the rules can not see, calling **tools** that run on
   a `VirtualPlan`, a copy of the snapshot. Read tools look at the plan,
   propose tools record an operation if it is valid and new, and say why when
   it is not. The copy follows what was proposed, so later reads and checks
   (duplicates, dependency cycles) see it.
4. The answer is a list of **operations**. The backend never changes the plan:
   the app shows them, the user approves, the app applies them with its own
   actions.

## Commands

```sh
npm install
npm test                 # core and server
npm run typecheck
npm run dev              # the Worker on http://localhost:8787 (wrangler dev)
npm run build            # core: dist/ (ESM + CJS + types)
npm run contract         # regenerate /contract after editing contract.ts
npm run validate:real -w @aivu/core -- path/to/basegroup.json [--verbose]
```

## Running it locally

```sh
cp packages/server/.dev.vars.example packages/server/.dev.vars   # then put your key in it
npm run dev
```

`.dev.vars` is not committed. With `ALLOW_INSECURE_DEV_AUTH=true` (development
only, ignored in production) the token is not checked. Without
`GEMINI_API_KEY` the backend still answers with the rules and the plan sheet
and says the AI is not configured.

To point the plan app at it, in the browser console of the app:

```js
localStorage.setItem('logicAssist.backend', 'external')
localStorage.setItem('logicAssist.url', 'http://localhost:8787')
```

and `localStorage.removeItem(...)` both to go back to the Firebase function.
The app origin has to be in `ALLOWED_ORIGINS` (http://localhost:8080 in the
example).

## The server

Hono on Web standard APIs, so the same app runs in a Worker and in the tests.

| | |
|---|---|
| `GET /health` | no token. `{ status, contractVersion, ai }` |
| `POST /v1/analyze` | json, max 5 MB. Rules and sheet, then the agent |
| `POST /v1/sheet` | multipart `pdf`, max 25 MB. Gemini reads it into the contract's shape |

* **Model.** Gemini over REST (`generateContent`), same API and default model
  (`gemini-3.5-flash-lite`) the Firebase functions used. The agent calls the
  tools of `@aivu/core` with function calling. If the model fails, the answer
  is still the rules and the sheet, with a warning: it never turns into a 500.
* **Schemas for Gemini.** It accepts a subset of JSON Schema, so what zod
  generates is rewritten (`gemini/schema.ts`). The contract and the tools stay
  the single source.
* **Auth.** Firebase ID token (`Authorization: Bearer`), checked with Google's
  keys: signature, expiry, issuer, audience, and that the project is in
  `FIREBASE_PROJECT_IDS`. The claim `role` has to be in `ALLOWED_ROLES`
  (default `admin,manager,production`, `*` for any). A bad token is 401, not
  being able to reach Google's keys is 503. With no project configured nobody
  gets in.
* **CORS.** Only `ALLOWED_ORIGINS`.
* **Logs.** Route, status, time and user. Never what was sent: it is customer
  data.

Configuration is in `packages/server/wrangler.jsonc`. What is committed is the
production default and is safe as it is: no origin and no Firebase project is
allowed until you add them.

### Deploying (later)

```sh
cd packages/server
npx wrangler secret put GEMINI_API_KEY
# fill FIREBASE_PROJECT_IDS and ALLOWED_ORIGINS in wrangler.jsonc, then
npx wrangler deploy
```

Things to know about Cloudflare:

* **CPU time.** The Free plan allows very little CPU per request; the analysis,
  the JSON validation and encoding a PDF to base64 are not free. Plan on the
  Paid plan, and look at the CPU time of the first real requests in the
  dashboard. It has not been measured outside `wrangler dev`.
* **One request, several model calls.** The agent makes up to 12 calls to
  Gemini inside one request. If that proves slow, the next step is streaming
  the steps (the `trace` is already there).
* **`GEMINI_BASE_URL`** can point Gemini through an AI Gateway for logs, rate
  limits and caching, without code changes.

## The contract

`packages/core/src/contract.ts` is the single source: zod schemas, the
TypeScript types and the JSON Schemas all come from it.

* Adding an optional field is compatible.
* Anything else (rename, remove, new required field, new operation kind) needs
  a new `CONTRACT_VERSION`; the app refuses an answer of another version.

Endpoints the app expects (contract v1):

| | |
|---|---|
| `POST /v1/analyze` | `{ contractVersion, snapshot, prompt }` -> `{ contractVersion, operations, findings, assistantText, trace }` |
| `POST /v1/sheet` | multipart, field `pdf` -> `{ contractVersion, sheet }` |
| errors | `{ contractVersion, error: { code, message } }` |

Requests carry `Authorization: Bearer <Firebase ID token>`.

## Customer data

Real plans and PDFs belong to the builders. They are not in this repo:

* `test/fixtures/woodberry-2557.*` is one plan with generic option names and
  geometry, ids replaced. Review it before this repo leaves the company.
* `validate:real` reads plans from paths you pass. Keep them in `/private`
  (git-ignored) or anywhere outside the repo.
