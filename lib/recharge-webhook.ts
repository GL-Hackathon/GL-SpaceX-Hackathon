// Recharge webhook verification and the subscription → consumable mapping.
//
// Official validation (docs.getrecharge.com/docs/webhooks-overview): the header
// is named X-Recharge-Hmac-Sha256, but the value is the hex SHA-256 of the
// API client secret concatenated with the raw request body (secret first).
// It is not HMAC-SHA256. Hashing anything other than the unmodified raw body
// fails validation.
//
// There is no Recharge customer id on `consumables` and CONTRACT.md does not
// grow one here. `subscription.email` (2021-01 payloads) or an included
// `customer.email` is used only when it matches `users.email`. Otherwise the
// caller updates the demo user's existing source='recharge' row — the same
// row scripts/reset-demo.ts seeds. GET /api/signal still computes
// days_until_empty from est_empty_date.

import { createHash, timingSafeEqual } from 'node:crypto';

/** Wire name is `X-Recharge-Hmac-Sha256`. Fetch header lookup is case-insensitive. */
export const RECHARGE_SIGNATURE_HEADER = 'x-recharge-hmac-sha256';

/**
 * Not part of the documented signature scheme. Honoured when a delivery
 * includes it so cancelled/paused topics are not applied. Absent on the
 * public 2021-11 examples; those dispatch on the top-level `subscription` key.
 */
export const RECHARGE_TOPIC_HEADER = 'x-recharge-topic';

/** Same inbox as scripts/reset-demo.ts. Not a contract field. */
export const DEMO_USER_EMAIL = 'demo@replenish.app';

const ACTIVE_SUBSCRIPTION_TOPICS = new Set([
  'subscription/created',
  'subscription/updated',
  'subscription/activated',
  'subscription/skipped',
  'subscription/unskipped',
  'subscription/swapped',
  'subscription/removed_from_skipped_charge',
]);

const INACTIVE_SUBSCRIPTION_TOPICS = new Set([
  'subscription/cancelled',
  'subscription/deleted',
  'subscription/paused',
]);

export type ConsumablePatch = {
  /** Hint for matching an existing row. Not written over a row that already has a product_key. */
  product_key: string;
  cadence_days: number;
  est_empty_date: string;
  last_delivery: string;
  source: 'recharge';
  /** Present only when the payload itself carried an email. Never stored. */
  email: string | null;
};

export type WebhookPlan =
  | { action: 'ignore'; reason: string }
  | { action: 'update'; patch: ConsumablePatch };

export type ApplyOutcome =
  | {
      kind: 'updated';
      consumable_id: string;
      product_key: string;
      mapped: 'email' | 'demo';
      created: boolean;
    }
  | { kind: 'ignored'; reason: string }
  | { kind: 'error'; status: number; error: string };

export function rechargeBodyDigest(secret: string, rawBody: string): string {
  return createHash('sha256').update(secret + rawBody, 'utf8').digest('hex');
}

/** True only when `header` matches SHA-256(secret + rawBody). Missing or malformed headers fail closed. */
export function verifyRechargeSignature(secret: string, rawBody: string, header: string | null): boolean {
  if (!secret || !header) return false;
  const received = header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(received)) return false;
  const expected = rechargeBodyDigest(secret, rawBody);
  return timingSafeEqual(Buffer.from(expected, 'utf8'), Buffer.from(received, 'utf8'));
}

export function planRechargeWebhook(payload: unknown, topicHeader: string | null): WebhookPlan {
  const topic = topicHeader?.trim().toLowerCase() || null;
  if (topic && INACTIVE_SUBSCRIPTION_TOPICS.has(topic)) {
    return { action: 'ignore', reason: `${topic} does not refresh a consumable` };
  }
  if (topic && !ACTIVE_SUBSCRIPTION_TOPICS.has(topic)) {
    return { action: 'ignore', reason: `${topic} is not a subscription cadence event` };
  }

  const root = asRecord(payload);
  const subscription = asRecord(root?.subscription);
  if (!subscription) {
    return { action: 'ignore', reason: 'payload has no subscription object' };
  }

  const status = subscription.status;
  if (status != null && String(status).trim() !== '' && String(status).toLowerCase() !== 'active') {
    return { action: 'ignore', reason: `subscription status ${String(status)} is not active` };
  }

  const estEmpty = dateOnly(subscription.next_charge_scheduled_at);
  if (!estEmpty) {
    return { action: 'ignore', reason: 'subscription has no next_charge_scheduled_at' };
  }

  const cadence = cadenceDays(subscription.order_interval_frequency, subscription.order_interval_unit);
  if (cadence == null) {
    return { action: 'ignore', reason: 'subscription interval is missing or unsupported' };
  }

  return {
    action: 'update',
    patch: {
      product_key: productKeyFromSubscription(subscription),
      cadence_days: cadence,
      est_empty_date: estEmpty,
      last_delivery: subtractDays(estEmpty, cadence),
      source: 'recharge',
      email: emailFromPayload(subscription, root),
    },
  };
}

export async function handleRechargeWebhook(input: {
  rawBody: string;
  signatureHeader: string | null;
  topicHeader: string | null;
  secret: string;
  apply: (patch: ConsumablePatch) => Promise<ApplyOutcome>;
}): Promise<{ status: number; body: Record<string, unknown> }> {
  if (!input.secret) {
    return { status: 401, body: { error: 'webhook secret not configured' } };
  }
  if (!verifyRechargeSignature(input.secret, input.rawBody, input.signatureHeader)) {
    return { status: 401, body: { error: 'invalid signature' } };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(input.rawBody);
  } catch {
    return { status: 400, body: { error: 'invalid json' } };
  }

  const plan = planRechargeWebhook(payload, input.topicHeader);
  if (plan.action === 'ignore') {
    return { status: 200, body: { ok: true, ignored: true, reason: plan.reason } };
  }

  try {
    const outcome = await input.apply(plan.patch);
    if (outcome.kind === 'ignored') {
      return { status: 200, body: { ok: true, ignored: true, reason: outcome.reason } };
    }
    if (outcome.kind === 'error') {
      return { status: outcome.status, body: { error: outcome.error } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        consumable_id: outcome.consumable_id,
        product_key: outcome.product_key,
        mapped: outcome.mapped,
        created: outcome.created,
        est_empty_date: plan.patch.est_empty_date,
        cadence_days: plan.patch.cadence_days,
        source: plan.patch.source,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'failed to update consumable';
    return { status: 500, body: { error: message } };
  }
}

export type ConsumableMatch =
  | { kind: 'update'; id: string; product_key: string }
  | { kind: 'insert' }
  | { kind: 'ambiguous' };

/**
 * Pick the recharge-sourced row to update.
 * One row (the seeded demo) is updated in place so product_key stays put.
 * A sku/title slug that already matches a product_key wins over that default.
 */
export function chooseRechargeConsumable(
  rows: { id: string; product_key: string }[],
  productKey: string,
): ConsumableMatch {
  if (rows.length === 0) return { kind: 'insert' };
  const exact = rows.find((row) => row.product_key === productKey);
  if (exact) return { kind: 'update', id: exact.id, product_key: exact.product_key };
  if (rows.length === 1) return { kind: 'update', id: rows[0].id, product_key: rows[0].product_key };
  const coffee = rows.find((row) => row.product_key === 'coffee_beans_1kg');
  if (coffee) return { kind: 'update', id: coffee.id, product_key: coffee.product_key };
  return { kind: 'ambiguous' };
}

function emailFromPayload(subscription: Record<string, unknown>, root: Record<string, unknown> | null): string | null {
  const nested = asRecord(subscription.customer);
  const included = asRecord(root?.customer);
  const raw = subscription.email ?? nested?.email ?? included?.email;
  if (typeof raw !== 'string') return null;
  const email = raw.trim();
  return email.length > 0 ? email : null;
}

function productKeyFromSubscription(subscription: Record<string, unknown>): string {
  const sku = slug(subscription.sku);
  if (sku) return sku;
  const title = slug(subscription.product_title);
  if (title) return title;
  return 'recharge_subscription';
}

function slug(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 80);
}

/** order_interval_frequency + order_interval_unit. Month is 30 days; that approximation is not stored as a new field. */
export function cadenceDays(frequency: unknown, unit: unknown): number | null {
  if (typeof frequency === 'string' && frequency.trim() === '') return null;
  const n = typeof frequency === 'number' ? frequency : Number(frequency);
  if (!Number.isFinite(n) || n <= 0) return null;
  const u = String(unit ?? 'day').trim().toLowerCase();
  let days: number;
  if (u === 'day' || u === 'days') days = n;
  else if (u === 'week' || u === 'weeks') days = n * 7;
  else if (u === 'month' || u === 'months') days = n * 30;
  else return null;
  const rounded = Math.round(days);
  return rounded > 0 ? rounded : null;
}

function dateOnly(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value.trim());
  return match ? match[1] : null;
}

function subtractDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}
