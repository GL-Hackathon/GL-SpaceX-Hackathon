# CONTRACT

Frozen at the 10:30 checkpoint. Gabriel emits signals and the panel. Lucas owns tokens, policy, orders, and the audit log. After this file is on `main`, neither side invents a field the other must read.

Change rule: any rename or new boundary field is a commit to this file, agreed by both, before code depends on it. Internal columns that the other person never reads are allowed.

## 1. ReorderSignal

The only object that crosses the ownership line. Gabriel’s scheduler emits it. Lucas’s policy engine consumes it.

```json
{
  "consumable_id": "uuid",
  "product_key": "string",
  "est_empty_date": "date",
  "days_until_empty": "number",
  "source": "recharge | csv_seed"
}
```

## 2. Policy verdict

Returned to the agent loop. `deny` and `escalate` never place an order.

- `allow`
- `deny(reason)`
- `escalate(reason)`

`check_token(token_id)` is the single integration call: cap, category, and TTL in; one of the three verdicts out.

## 3. Tables

Exactly these eight. Every table has `user_id`. RLS is `auth.uid() = user_id`. A second user sees zero rows.

`users`, `consumables`, `shops`, `price_findings`, `spend_tokens`, `orders`, `audit_log`, `consent`

## 4. Token

`spend_tokens` is minted and revoked only from the privacy panel.

| Column | Meaning |
|---|---|
| `max_amount` | Spend cap |
| `category_scope` | Allowed category (demo: consumables) |
| `issued_at` | When the token was minted |
| `expires_at` | TTL |
| `revoked_at` | Set on one-tap revoke; null while live |
| `status` | Live or revoked. Revoke flips this; the policy engine then denies |

## 5. Audit record

Written by Lucas’s order path. This is what the panel renders.

```json
{
  "action": "string",
  "inputs": "jsonb",
  "options": "jsonb",
  "choice": "string",
  "reason": "string",
  "token_id": "uuid"
}
```

## 6. Who writes what

| Data | Writer | Reader |
|---|---|---|
| `consumables`, ReorderSignal | Gabriel | Lucas |
| `price_findings` | Gabriel | both |
| `spend_tokens`, `orders`, `audit_log` | Lucas | Gabriel’s panel |
| `consent` | privacy panel | both |

Gabriel’s UI reads `audit_log`, `spend_tokens`, and `consent` only. It does not read other tables to render the panel.

## 7. Integration checkpoints

| Time | Checkpoint |
|---|---|
| 10:30 | this contract frozen (both) — done, on `main` |
| 13:30 | first merge — order path live |
| 14:30 | second merge — panel + revoke |

## 8. As-built notes (Lucas, trust layer)

- `ReorderSignal.source` is `recharge | csv_seed` — the code, the CSV seed, and the
  `consumables.source` column all use those exact two literals. No other value is emitted.
- `checkToken(token, { amount, category, shop_id })` in `lib/policy-engine.ts` returns the
  verdict. Ordering: revoked → expired → wrong shop → wrong category → over cap (escalate).
- `price_findings` has **no `user_id`** column (it hangs off `consumable_id`), so its RLS
  policy derives ownership through the parent consumable. Do not add a column to "fix" it.

## 9. As-built notes (Recharge webhook)

No new boundary field. `POST /api/recharge/webhook` writes existing `consumables`
columns only: `cadence_days`, `est_empty_date`, `last_delivery`, `source = recharge`.
`GET /api/signal` still computes `days_until_empty`.

Recharge's subscription payload has no Supabase user id. If `subscription.email`
or an included `customer.email` matches `users.email`, that user is updated.
Otherwise the demo user's existing `source = recharge` row is updated. No
`recharge_customer_id` column. The seeded demo is unchanged until a signature-valid
subscription event arrives.
