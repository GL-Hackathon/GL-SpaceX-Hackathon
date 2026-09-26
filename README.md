# Replenish Autopilot

**A cross-retailer replenishment agent that runs your cart without building a profile of you.**

> Autonomous commerce isn't blocked by AI. It's blocked by trust. We built the trust layer
> that makes your cart safe to hand over.

Grok Bot Commerce · London Hackathon — Fleek HQ, 26 September 2026
**Team:** Lucas Malik (trust layer) · Gabriel Moura (brain + face)

**Live:** https://replenish-autopilot.vercel.app
**Run sheet:** [`docs/RUNSHEET.md`](./docs/RUNSHEET.md)

---

## The idea in one line

Everyone is racing to give agents a wallet. We built the thing that decides whether the
wallet is allowed to open — and proves, afterwards, exactly what it did and why.

## What it does

`signal → compare (3 shops, live) → policy check → scoped order (Shopify) → audit trail`

1. **Signal** — from a cadence and a last-delivery date, derive "coffee is empty in 4 days".
   No purchase history, no profile.
2. **Compare** — live prices from three retailers via Tavily, ranked, with the pack price
   extracted (retail ranges and per-100g unit prices stripped). Cached for
   `PRICE_CACHE_TTL_MINUTES` so a live demo never trips a rate limit.
3. **Explain** — **Grok** (xAI) is given the signal, the three prices and the mandate's
   constraints, and writes the one sentence the audit trail shows. See below.
4. **Policy check** — a spend token carries **cap + category scope + shop scope + expiry**.
   The engine returns `allow | deny | escalate`. **`deny` and `escalate` never place an order.**
5. **Order** — a real order on a real Shopify store, in test mode.
6. **Audit** — every decision logs the inputs, the options compared, the choice and the reason.

Open the live URL and press **Run replenishment** to see all six steps in one click.

## Where Grok sits — the decision, not the spend

A model that can be talked into spending is not a trust layer. So Grok explains and does not
decide:

- It runs **server-side**, after the caller's JWT is verified, on the compare path.
- It receives the reorder signal, the prices already fetched, and the mandate's constraints.
  It receives **no profile, no Shopify admin token, no service-role key, and no tools**. Web
  search stays off — Tavily is already the evidence, and a second search would widen what the
  agent knows.
- Whatever shop it names is run through **`checkToken`** and only logged. Authority never
  moves: `deny` and `escalate` still never reach `placeOrder`.
- **`store: false`** — the xAI Responses API otherwise retains the conversation for 30 days,
  which is a profile, and we promised not to build one.
- Any failure — missing key, HTTP error, timeout, junk JSON — falls back to the deterministic
  template reason. The demo finishes either way.

The audit line it produces is the most interesting thing on the screen:

> *"Order placed at Shopify Dev Store per the spending mandate even though Waitrose has the
> lowest price found at £13.50."*

That is a real contradiction, explained: the cheapest shop is not the shop the mandate allows.

Model picked by measurement, not vibes: `grok-4.3` took 8.3s, `grok-4.5` took 9.7s *and got the
situation wrong*, `grok-4.20-0309-non-reasoning` takes ~1s and is correct.

## The sponsor stack, and what each one actually does

Nothing here is a logo on a slide — every one of these is load-bearing:

| | Used for |
|---|---|
| **Cursor** | The entire build, including the trust layer and this README |
| **Grok Bots** | A `Replenish` bot carries the reordering job. Message it *"coffee is running low"* and it attempts the spend — and is refused, which is the point |
| **Grok (xAI API)** | Writes the explanation on every compare decision. Explains, never authorises — see above |
| **Shopify** | A real dev store. Real order objects, `test: true`, charged amount stored verbatim |
| **Supabase** | Postgres + **RLS** for user-owned data, and Auth: the JWT that every API route requires |

The Grok Bot and the Grok API are deliberately different roles: the **bot is the agent** that
wants to spend, and the **API call is the reasoning** the panel shows. Neither one can authorise
anything on its own — a spend token and the policy engine sit between both of them and your card.


## Privacy architecture — the differentiator

| Principle | How it's actually enforced |
|---|---|
| Data minimisation | One row per consumable. No profile store, no history, no browsing data. |
| User-owned data | Supabase RLS on all 8 tables: `auth.uid() = user_id`. |
| Scoped spend authority | Cap + category + shop + TTL + revoke, modelled on UCP/AP2 mandates. |
| Explainable decisions | Every action writes inputs, options compared, choice and reason. |
| Consent and control | Opt-in per category; one-tap revoke that takes effect server-side. |

### The privacy panel proves it rather than asserting it

The panel reads the database with **the signed-in user's own credentials and the public anon
key** — no service-role key reaches the browser. The **"View as"** toggle signs in as a second
account and shows the same panel, empty. That is row-level security demonstrated on screen,
not described on a slide.

## Security model

The API routes talk to Postgres through the service-role key, which **bypasses RLS** — so the
routes enforce their own rules:

- **Every user-facing route requires the caller's Supabase JWT.** No token, no data: `401`.
  `POST /api/recharge/webhook` is the exception: Recharge has no user session, so that
  route checks `X-Recharge-Hmac-Sha256` and rejects a missing or invalid signature.
- Every JWT-authenticated query is **scoped to the authenticated user**, never to a value from the body or
  query string. The webhook writes one consumable: the user whose email matches the signed
  payload, or the demo user's existing `source=recharge` row when it does not.
- Another user's `consumable_id` or `token_id` returns **404, not 403** — the endpoints can't
  be used to enumerate what exists.
- The agent and the panel go through **the same authenticated door**. There is no
  unauthenticated path to spending.

## Verified

| Check | Result |
|---|---|
| Full sequence, end to end | **7/7 pass, ~9s** (against a 180s demo budget) |
| Grok explanation | `explained_by: grok`, ~1s; falls back to the template reason if the model is slow, down, or returns junk |
| Policy engine | `npm run check:policy` — 7/7 (cap, category, TTL, revoke, wrong shop, no token) |
| Live price compare | 3 shops, stable pick, evidence URLs |
| RLS isolation | demo user sees 27 rows; second account sees **0** |
| Auth | `401` without a JWT, `403` across users, `401` on a forged token |
| Recharge webhook | `npm run check:recharge` — valid signature accepted, invalid rejected, no live Recharge call |
| Orders | real Shopify dev-store orders, `test: true`, stored amount = **what Shopify charged** |
| Build | `npm run build` passes |

## Setup

```bash
npm install
cp .env.example .env.local     # fill in the values
supabase link --project-ref inpoajxknyuuoyddeoqo
supabase db push               # applies supabase/migrations/0001_init.sql
npm run dev
```

### Rehearsing the demo

```bash
npm run reset:demo
```

Revoking is the demo's closing beat and it is **irreversible by design** — this restores one
live token, the consent state, the single consumable and the three-beat audit trail. Run it
before every rehearsal and before the real run.

## Standards alignment

Spend tokens and mandates are modelled on **UCP / AP2** (Universal Commerce Protocol), the
open standard co-developed by Google, Shopify, Walmart, Amazon, Stripe, Visa and Mastercard —
not bespoke plumbing.

## Known trade-offs

Stated rather than hidden:

- **The demo account's password is in the client bundle.** `app/page.tsx` is a client
  component that signs in automatically so a judge can see RLS without a login step. That
  means anyone can sign in as the demo user while the site is live. Acceptable for a demo
  account; would be replaced with a real auth flow for anything else.
- **The project's `jwt_exp` is raised to 24h for the event.** Default is 1h, which the Grok
  Bot's stored credential would outlive mid-demo. It matters little here — the demo password
  is already public (above), so this lengthens an already-public credential rather than
  widening the blast radius. Reset it to `3600` after the event.
- **Orders are test orders.** Real order objects in a real Shopify dev store, flagged
  `test: true` so no money moves.
- **The dev store's catalogue price can differ from the scraped retail price.** We store what
  Shopify actually charged, so the panel can never disagree with the store.

## Boundaries — deliberately not built

Recurring billing, returns, multi-currency, merchant-facing app, more than three shops.
The demo still runs on the seeded consumable. `POST /api/recharge/webhook` is ready
for a live subscription callback and does not replace that seed.

See [`CONTRACT.md`](./CONTRACT.md) for the frozen interfaces.

## API

```
GET  /api/signal?user_id=<id>   -> ReorderSignal[]        (auth required)
POST /api/compare               -> price_findings[]       (auth required)
POST /api/order                 -> policy check -> Shopify order -> orders + audit_log
POST /api/recharge/webhook      -> consumable cadence + est_empty_date (Recharge signature)
```

Signal, compare, and order require `Authorization: Bearer <supabase-jwt>`.
The Recharge webhook requires `X-Recharge-Hmac-Sha256` instead.

`POST /api/compare` also returns `reason` (the sentence shown in the audit trail) and
`explained_by` (`grok` | `fallback`).
