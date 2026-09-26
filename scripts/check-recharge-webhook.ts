// Signs a fixture body the way Recharge does and proves a valid digest is
// accepted and an invalid one is rejected. Does not call Recharge or Supabase.
//
// Run: npm run check:recharge
import { createHmac } from 'node:crypto';
import {
  handleRechargeWebhook,
  rechargeBodyDigest,
  verifyRechargeSignature,
  chooseRechargeConsumable,
  type ConsumablePatch,
} from '../lib/recharge-webhook.ts';

const secret = 'test_client_secret';

// Bytes are fixed. JSON.stringify would be free to change spacing, and
// Recharge's check fails if one space is lost.
const subscriptionBody = [
  '{',
  '  "subscription": {',
  '    "id": 63898947,',
  '    "status": "ACTIVE",',
  '    "email": "not-a-user@example.com",',
  '    "sku": "coffee_beans_1kg",',
  '    "product_title": "Coffee Beans 1kg",',
  '    "order_interval_frequency": "28",',
  '    "order_interval_unit": "day",',
  '    "next_charge_scheduled_at": "2026-10-01T00:00:00"',
  '  }',
  '}',
].join('\n');

const chargeBody = '{"charge":{"id":1,"status":"success"}}';

let failures = 0;

function check(name: string, pass: boolean, detail?: string) {
  if (pass) {
    console.log(`  ok  ${name}`);
  } else {
    failures += 1;
    console.error(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const good = rechargeBodyDigest(secret, subscriptionBody);
check('valid digest accepted', verifyRechargeSignature(secret, subscriptionBody, good));
check(
  'uppercase header accepted',
  verifyRechargeSignature(secret, subscriptionBody, good.toUpperCase()),
);
check(
  'tampered body rejected',
  !verifyRechargeSignature(secret, subscriptionBody + ' ', good),
);
check(
  'wrong secret rejected',
  !verifyRechargeSignature(secret + 'x', subscriptionBody, good),
);
check('missing header rejected', !verifyRechargeSignature(secret, subscriptionBody, null));
check('empty header rejected', !verifyRechargeSignature(secret, subscriptionBody, ''));
check('short header rejected', !verifyRechargeSignature(secret, subscriptionBody, 'abcd'));

// The header says HMAC. Recharge's published algorithm is plain SHA-256(secret + body).
const realHmac = createHmac('sha256', secret).update(subscriptionBody).digest('hex');
check('standard HMAC-SHA256 rejected', !verifyRechargeSignature(secret, subscriptionBody, realHmac));

const monthBody = JSON.stringify({
  subscription: {
    id: 63898947,
    status: 'active',
    order_interval_frequency: 1,
    order_interval_unit: 'month',
    next_charge_scheduled_at: '2021-12-17T00:00:00',
    product_title: 'ABC Shirt',
    sku: 'TOM0001',
  },
});

let applied: ConsumablePatch | null = null;
let applyCalls = 0;
const apply = async (patch: ConsumablePatch) => {
  applyCalls += 1;
  applied = patch;
  return {
    kind: 'updated' as const,
    consumable_id: 'consumable-1',
    product_key: 'coffee_beans_1kg',
    mapped: 'demo' as const,
    created: false,
  };
};

const accepted = await handleRechargeWebhook({
  rawBody: subscriptionBody,
  signatureHeader: good,
  topicHeader: 'subscription/updated',
  secret,
  apply,
});
check('signed subscription/updated accepted', accepted.status === 200 && accepted.body.ok === true, JSON.stringify(accepted.body));
check('apply ran once', applyCalls === 1, `calls=${applyCalls}`);
check('cadence is 28 days', applied?.cadence_days === 28, `cadence=${applied?.cadence_days}`);
check('est_empty_date from next charge', applied?.est_empty_date === '2026-10-01', applied?.est_empty_date);
check('last_delivery is one cadence earlier', applied?.last_delivery === '2026-09-03', applied?.last_delivery);
check('source is recharge', applied?.source === 'recharge');
check('email is passed through for matching only', applied?.email === 'not-a-user@example.com');

const rejected = await handleRechargeWebhook({
  rawBody: subscriptionBody,
  signatureHeader: realHmac,
  topicHeader: 'subscription/updated',
  secret,
  apply,
});
check('invalid signature is 401', rejected.status === 401 && rejected.body.error === 'invalid signature');
check('invalid signature does not apply', applyCalls === 1, `calls=${applyCalls}`);

const missing = await handleRechargeWebhook({
  rawBody: subscriptionBody,
  signatureHeader: null,
  topicHeader: null,
  secret,
  apply,
});
check('missing signature is 401', missing.status === 401);

const unconfigured = await handleRechargeWebhook({
  rawBody: subscriptionBody,
  signatureHeader: good,
  topicHeader: null,
  secret: '',
  apply,
});
check('missing secret is 401 and does not apply', unconfigured.status === 401 && applyCalls === 1);

const chargeSig = rechargeBodyDigest(secret, chargeBody);
const ignored = await handleRechargeWebhook({
  rawBody: chargeBody,
  signatureHeader: chargeSig,
  topicHeader: 'charge/paid',
  secret,
  apply,
});
check('signed charge is acknowledged and ignored', ignored.status === 200 && ignored.body.ignored === true);
check('ignored charge does not apply', applyCalls === 1);

const cancelled = await handleRechargeWebhook({
  rawBody: subscriptionBody,
  signatureHeader: good,
  topicHeader: 'subscription/cancelled',
  secret,
  apply,
});
check('cancelled subscription does not refresh the row', cancelled.status === 200 && cancelled.body.ignored === true && applyCalls === 1);

const monthSig = rechargeBodyDigest(secret, monthBody);
const month = await handleRechargeWebhook({
  rawBody: monthBody,
  signatureHeader: monthSig,
  topicHeader: null,
  secret,
  apply,
});
check('month interval without a topic header is accepted', month.status === 200 && month.body.cadence_days === 30, JSON.stringify(month.body));
check('month fixture maps sku to product_key hint', applied?.product_key === 'tom0001');

const single = chooseRechargeConsumable(
  [{ id: 'row-1', product_key: 'coffee_beans_1kg' }],
  'tom0001',
);
check(
  'single recharge row is updated in place',
  single.kind === 'update' && single.product_key === 'coffee_beans_1kg',
);

const exact = chooseRechargeConsumable(
  [
    { id: 'row-1', product_key: 'coffee_beans_1kg' },
    { id: 'row-2', product_key: 'tom0001' },
  ],
  'tom0001',
);
check('matching product_key wins', exact.kind === 'update' && exact.id === 'row-2');

const none = chooseRechargeConsumable([], 'tom0001');
check('no recharge row inserts', none.kind === 'insert');

if (failures > 0) {
  console.error(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nrecharge webhook checks passed');
