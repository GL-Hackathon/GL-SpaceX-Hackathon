import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import {
  DEMO_USER_EMAIL,
  RECHARGE_SIGNATURE_HEADER,
  RECHARGE_TOPIC_HEADER,
  chooseRechargeConsumable,
  handleRechargeWebhook,
  type ApplyOutcome,
  type ConsumablePatch,
} from '@/lib/recharge-webhook';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/recharge/webhook
 *
 * Recharge calls this with no Supabase JWT. Authentication is the
 * X-Recharge-Hmac-Sha256 header over the raw body (see lib/recharge-webhook.ts).
 * A valid active subscription updates cadence_days, est_empty_date, and
 * last_delivery on an existing consumable and sets source to "recharge".
 * GET /api/signal is unchanged: it still derives days_until_empty.
 *
 * Customer mapping: if the payload email matches users.email, that user is
 * updated. There is no recharge customer id column. Anything we cannot match
 * updates the demo user's existing source='recharge' row (seeded by
 * reset-demo) instead of adding a contract field. product_key on that row
 * is left alone so the seeded coffee consumable stays the demo product.
 * charge/*, order/*, and inactive subscription topics are acknowledged and
 * ignored so Recharge does not retry-delete the webhook.
 */
export async function POST(req: Request) {
  const rawBody = await req.text();
  const result = await handleRechargeWebhook({
    rawBody,
    signatureHeader: req.headers.get(RECHARGE_SIGNATURE_HEADER),
    topicHeader: req.headers.get(RECHARGE_TOPIC_HEADER),
    secret: process.env.RECHARGE_WEBHOOK_SECRET ?? '',
    apply: applySubscriptionUpdate,
  });
  return NextResponse.json(result.body, { status: result.status });
}

async function applySubscriptionUpdate(patch: ConsumablePatch): Promise<ApplyOutcome> {
  const user = await resolveUser(patch.email);
  if (!user) {
    return { kind: 'ignored', reason: 'no supabase user to attach this subscription to' };
  }

  const { data: rows, error: readError } = await supabaseAdmin
    .from('consumables')
    .select('id, product_key')
    .eq('user_id', user.userId)
    .eq('source', 'recharge');
  if (readError) return { kind: 'error', status: 500, error: readError.message };

  const choice = chooseRechargeConsumable(rows ?? [], patch.product_key);
  if (choice.kind === 'ambiguous') {
    return { kind: 'ignored', reason: 'more than one recharge consumable and none matched the subscription' };
  }

  const write = {
    cadence_days: patch.cadence_days,
    est_empty_date: patch.est_empty_date,
    last_delivery: patch.last_delivery,
    source: 'recharge' as const,
  };

  if (choice.kind === 'update') {
    const { data, error } = await supabaseAdmin
      .from('consumables')
      .update(write)
      .eq('id', choice.id)
      .eq('user_id', user.userId)
      .select('id, product_key')
      .single();
    if (error || !data) return { kind: 'error', status: 500, error: error?.message ?? 'update failed' };
    return {
      kind: 'updated',
      consumable_id: data.id as string,
      product_key: data.product_key as string,
      mapped: user.mapped,
      created: false,
    };
  }

  const { data, error } = await supabaseAdmin
    .from('consumables')
    .insert({
      user_id: user.userId,
      product_key: patch.product_key,
      ...write,
    })
    .select('id, product_key')
    .single();
  if (error || !data) return { kind: 'error', status: 500, error: error?.message ?? 'insert failed' };
  return {
    kind: 'updated',
    consumable_id: data.id as string,
    product_key: data.product_key as string,
    mapped: user.mapped,
    created: true,
  };
}

async function resolveUser(email: string | null): Promise<{ userId: string; mapped: 'email' | 'demo' } | null> {
  if (email) {
    const { data, error } = await supabaseAdmin.from('users').select('id').eq('email', email).limit(1);
    if (error) throw new Error(error.message);
    const id = data?.[0]?.id;
    if (typeof id === 'string') return { userId: id, mapped: 'email' };
  }

  const { data, error } = await supabaseAdmin.from('users').select('id').eq('email', DEMO_USER_EMAIL).limit(1);
  if (error) throw new Error(error.message);
  const id = data?.[0]?.id;
  if (typeof id === 'string') return { userId: id, mapped: 'demo' };
  return null;
}
