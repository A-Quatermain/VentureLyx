/**
 * Venturelyx :: Stripe billing routes.
 *
 * checkout/portal create sessions only — neither one writes subscription
 * state. The webhook is the only writer (lib/billingEntitlements.ts's own
 * header explains why), which is also why checkout doesn't optimistically
 * unlock anything on return: the real unlock happens moments later when
 * Stripe's checkout.session.completed event lands here.
 *
 * The webhook route is registered in its own nested plugin scope
 * specifically so addContentTypeParser('application/json', ...) overriding
 * to a raw Buffer applies ONLY to that one route — Fastify's content-type
 * parsers are scoped to the plugin encapsulation they're registered in, so
 * checkout/portal above keep normal JSON parsing. constructEvent() needs
 * the exact raw bytes Stripe signed; re-serializing an already-parsed JSON
 * object would produce different bytes and fail signature verification
 * even for a 100% legitimate event.
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import Stripe from 'stripe';
import { stripe, resolvePrice, resolvePrices, getOrCreateStripeCustomer } from '../lib/stripe.js';
import { syncEntitlements } from '../lib/billingEntitlements.js';
import { HttpError } from '../plugins/context.js';
import { withPlatform, withTenant, type Querier } from '../lib/db.js';
import { newSessionToken, hashToken } from '../lib/auth.js';
import { sendEmail } from '../lib/email.js';
import { billingReceiptEmail, billingPaymentFailedEmail, onboardingWelcomeEmail } from '../lib/emailTemplates.js';

const APP_BASE_URL = process.env.APP_BASE_URL ?? 'https://app.venturelyx.com';
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

/** Re-fetches the subscription fresh from Stripe (expanded, so every item's
 *  price.lookup_key is present) rather than trusting the webhook payload's
 *  own snapshot — correctness over saving one API call, and this is called
 *  at most a few times per billing event, never per-request. Resolves the
 *  owning org from the subscription's own metadata.org_id first (set at
 *  checkout), falling back to the customer-id join — either is normally
 *  sufficient; keeping both means one missing field can't orphan an event. */
async function syncSubscriptionFromStripe(stripeSubscriptionId: string): Promise<void> {
  const sub = await stripe.subscriptions.retrieve(stripeSubscriptionId, {
    expand: ['items.data.price'],
  });

  const orgId = sub.metadata.org_id || await withPlatform((q) =>
    q.one<{ org_id: string }>(
      `SELECT org_id FROM billing_customers WHERE stripe_customer_id = $1`,
      [typeof sub.customer === 'string' ? sub.customer : sub.customer.id],
    ),
  ).then((r) => r?.org_id);

  if (!orgId) {
    console.error({ subscriptionId: stripeSubscriptionId }, 'billing webhook: could not resolve org for subscription');
    return;
  }

  const lookupKeys = sub.items.data
    .map((item) => (item.price as Stripe.Price).lookup_key)
    .filter((k): k is string => !!k);

  // Stripe's Subscription type carries current_period_end on each item in
  // newer API versions, not the top-level object — current_period_end here
  // is the latest (and in practice only, for every catalog price above,
  // since nothing mixes billing intervals within one subscription) item's.
  const periodEnd = sub.items.data[0]?.current_period_end;
  const cancelAt = sub.cancel_at;

  await withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
    await q.exec(
      `INSERT INTO billing_subscriptions
         (org_id, stripe_subscription_id, status, price_lookup_keys, current_period_end, cancel_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (org_id) DO UPDATE SET
         stripe_subscription_id = EXCLUDED.stripe_subscription_id,
         status = EXCLUDED.status,
         price_lookup_keys = EXCLUDED.price_lookup_keys,
         current_period_end = EXCLUDED.current_period_end,
         cancel_at = EXCLUDED.cancel_at,
         updated_at = now()`,
      [
        orgId, sub.id, sub.status, lookupKeys,
        periodEnd ? new Date(periodEnd * 1000) : null,
        cancelAt ? new Date(cancelAt * 1000) : null,
      ],
    );
    await syncEntitlements(q, orgId, sub.status, lookupKeys);

    // Conversion: the one place a prospect org ever becomes a real
    // customer. Guarded on org.status itself (not on event type) so this
    // is idempotent across every subscription.updated retry/replay — it
    // only ever fires once, the moment status is still 'prospect'.
    if (sub.status === 'active' || sub.status === 'trialing') {
      await convertProspectIfNeeded(q, orgId, sub);
    }
  });
}

/**
 * Flips organizations.status prospect -> onboarding on first confirmed
 * payment — the payment gate (plugins/context.ts's requireProvisioned)
 * keys off exactly this column, for both paths that can reach here:
 *
 *   - Admin-generated checkout (routes/growthScans.ts): sub.metadata.deal_id
 *     is set. Advances the deal, marks its checkout session completed, and
 *     invites the primary contact as owner via the EXISTING org_invites /
 *     invite-accept flow (routes/auth.ts) — this is the only account/
 *     membership ever created for one of these orgs, and it reuses the
 *     same organization id throughout. Zero duplicate organizations.
 *   - Self-service signup (routes/growthScans.ts's self-service endpoint):
 *     no deal_id — the real user+membership already exist from signup,
 *     so there's nothing left to provision beyond the status flip itself.
 */
async function convertProspectIfNeeded(q: Querier, orgId: string, sub: Stripe.Subscription): Promise<void> {
  const org = await q.one<{ status: string; name: string }>(`SELECT status, name FROM organizations WHERE id = $1`, [orgId]);
  if (!org || org.status !== 'prospect') return;

  await q.exec(`UPDATE organizations SET status = 'onboarding', updated_at = now() WHERE id = $1`, [orgId]);

  const dealId = sub.metadata.deal_id;
  if (!dealId) return;

  await q.exec(`UPDATE deals SET stage = 'paid', updated_at = now() WHERE id = $1`, [dealId]);
  await q.exec(
    `UPDATE deal_checkout_sessions SET status = 'completed', completed_at = now(), stripe_subscription_id = $2
      WHERE deal_id = $1 AND status = 'open'`,
    [dealId, sub.id],
  );

  const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;
  const customer = await stripe.customers.retrieve(customerId);
  const email = customer && !customer.deleted ? customer.email : null;

  if (email) {
    const inviteToken = newSessionToken();
    await q.exec(
      `INSERT INTO org_invites (org_id, email, role, token_hash, expires_at)
       VALUES ($1,$2,'owner',$3, now() + interval '14 days')
       ON CONFLICT (org_id, email) WHERE accepted_at IS NULL
       DO UPDATE SET token_hash = EXCLUDED.token_hash, expires_at = EXCLUDED.expires_at, created_at = now()`,
      [orgId, email, hashToken(inviteToken)],
    );
    const { subject, html, text } = onboardingWelcomeEmail(org.name, `${APP_BASE_URL}/invite/accept?token=${inviteToken}`);
    await sendEmail(q, { to: email, subject, html, text, template: 'onboarding_welcome', orgId });
  }

  if (sub.metadata.plan_key === 'founding') {
    await scheduleFoundingReversion(sub).catch((err) => {
      // The subscription itself is already correct either way — a
      // schedule failure here must not fail the webhook (Stripe would
      // retry an already-fully-applied payment event forever). Worst
      // case: a founding subscription keeps billing at the founding rate
      // past 12 months until someone notices and fixes it by hand.
      console.error({ err, subscriptionId: sub.id }, 'failed to create Founding Business reversion schedule');
    });
  }
}

/** Converts the flat Founding Business subscription into a two-phase
 *  Subscription Schedule: 12 billing cycles at the founding rate, then an
 *  open-ended phase on the SAME launch_growth_monthly price object Launch
 *  & Growth itself uses — a structural revert, not a duplicate price. */
async function scheduleFoundingReversion(sub: Stripe.Subscription): Promise<void> {
  const reversionPrice = await resolvePrice('launch_growth_monthly');
  const schedule = await stripe.subscriptionSchedules.create({ from_subscription: sub.id });
  // Replacing the whole phases array requires the first phase's start_date
  // explicitly — Stripe does not infer it from the schedule it was just
  // derived from (verified against a real 400: "missing at least one
  // phase with a `start_date` to anchor end dates to").
  await stripe.subscriptionSchedules.update(schedule.id, {
    phases: [
      { items: schedule.phases[0]!.items as never, start_date: schedule.phases[0]!.start_date, duration: { interval: 'month', interval_count: 12 } },
      { items: [{ price: reversionPrice.id, quantity: 1 }] },
    ],
  });
}

/** Resolves the org and a real contact email straight from Stripe's own
 *  invoice/customer objects — never guesses which Venturelyx user to
 *  notify, since the Stripe customer's email is exactly the address that
 *  actually completed checkout. orgId comes from the subscription's
 *  metadata (set at checkout) exactly like syncSubscriptionFromStripe. */
async function notifyBillingEmail(invoice: Stripe.Invoice, kind: 'paid' | 'payment_failed'): Promise<void> {
  const subField = invoice.parent?.subscription_details?.subscription;
  const subId = typeof subField === 'string' ? subField : subField?.id;
  if (!subId) return;

  const sub = await stripe.subscriptions.retrieve(subId);
  const orgId = sub.metadata.org_id;
  if (!orgId) return;

  const customerId = typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id;
  const customer = customerId ? await stripe.customers.retrieve(customerId) : null;
  const email = customer && !customer.deleted ? customer.email : null;
  if (!email) return;

  await withTenant({ orgId, userId: null, isStaff: false }, async (q) => {
    const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
    if (!org) return;

    if (kind === 'paid') {
      const { subject, html, text } = billingReceiptEmail(
        org.name, `$${(invoice.amount_paid / 100).toFixed(2)}`, sub.items.data[0]?.price.lookup_key ?? 'Venturelyx',
      );
      await sendEmail(q, { to: email, subject, html, text, template: 'billing_receipt', orgId });
    } else {
      const { subject, html, text } = billingPaymentFailedEmail(org.name, `${process.env.APP_BASE_URL ?? 'https://app.venturelyx.com'}/settings`);
      await sendEmail(q, { to: email, subject, html, text, template: 'billing_payment_failed', orgId });
    }
  });
}

const checkoutInput = z.object({
  lookupKeys: z.array(z.string().min(1)).min(1),
});

export default async function billingRoutes(app: FastifyInstance) {
  app.get('/billing/status', async (req) => {
    req.requireRole('viewer');
    const orgId = req.ctx.orgId!;

    return req.db(async (q) => {
      const subscription = await q.one(
        `SELECT status, price_lookup_keys, current_period_end, cancel_at
           FROM billing_subscriptions WHERE org_id = $1`,
        [orgId],
      );
      return { subscription };
    });
  });

  app.post('/billing/checkout', async (req) => {
    req.requireRole('admin');
    const sess = req.requireAuth();
    const orgId = req.ctx.orgId!;
    const { lookupKeys } = checkoutInput.parse(req.body);

    const prices = await resolvePrices(lookupKeys);

    return req.db(async (q) => {
      const org = await q.one<{ name: string }>(`SELECT name FROM organizations WHERE id = $1`, [orgId]);
      if (!org) throw new HttpError(404, 'Organization not found', 'not_found');

      const customerId = await getOrCreateStripeCustomer(q, orgId, org.name, sess.email);

      // If this org has a Growth Scan Funnel deal (the self-service $129
      // signup — routes/growthScans.ts — creates one at intake_started),
      // carry its id so convertProspectIfNeeded can advance it on
      // checkout.session.completed exactly like an admin-generated
      // checkout does. Absent for a pre-existing paying customer adding a
      // module or a second business — nothing to advance there.
      const deal = await q.one<{ id: string }>(
        `SELECT d.id FROM deals d JOIN pipelines p ON p.id = d.pipeline_id
          WHERE d.org_id = $1 AND p.name = 'Growth Scan Funnel'
          ORDER BY d.created_at DESC LIMIT 1`,
        [orgId],
      );

      const session = await stripe.checkout.sessions.create({
        mode: 'subscription',
        customer: customerId,
        line_items: prices.map((p) => ({ price: p.id, quantity: 1 })),
        allow_promotion_codes: true,
        subscription_data: {
          metadata: {
            org_id: orgId,
            ...(deal ? { deal_id: deal.id, plan_key: lookupKeys[0]!.replace(/_monthly$/, '') } : {}),
          },
        },
        success_url: `${APP_BASE_URL}/settings?billing=success`,
        cancel_url: `${APP_BASE_URL}/settings?billing=cancelled`,
      });

      return { url: session.url };
    });
  });

  app.post('/billing/portal', async (req) => {
    req.requireRole('admin');
    const orgId = req.ctx.orgId!;

    return req.db(async (q) => {
      const existing = await q.one<{ stripe_customer_id: string }>(
        `SELECT stripe_customer_id FROM billing_customers WHERE org_id = $1`, [orgId],
      );
      if (!existing) {
        throw new HttpError(400, 'This business has no billing account yet — subscribe first.', 'no_customer');
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: existing.stripe_customer_id,
        return_url: `${APP_BASE_URL}/settings`,
      });
      return { url: session.url };
    });
  });

  // Nested scope: addContentTypeParser here does not leak to the two
  // routes above, or to any other route file — see this file's own header.
  await app.register(async (webhookScope) => {
    webhookScope.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
      done(null, body);
    });

    webhookScope.post('/billing/webhook', async (req, reply) => {
      if (!webhookSecret) {
        req.log.error('STRIPE_WEBHOOK_SECRET is not set — refusing to process webhook');
        return reply.status(500).send();
      }
      const signature = req.headers['stripe-signature'];
      if (!signature || typeof signature !== 'string') {
        return reply.status(400).send('Missing stripe-signature header');
      }

      let event: Stripe.Event;
      try {
        event = stripe.webhooks.constructEvent(req.body as Buffer, signature, webhookSecret);
      } catch (err) {
        req.log.warn({ err }, 'Stripe webhook signature verification failed');
        return reply.status(400).send('Invalid signature');
      }

      // Idempotency: a Stripe retry, or a replayed event from `stripe
      // listen` during testing, must not re-apply an entitlement change.
      // withPlatform, not withTenant — this event has no org context of
      // its own yet, and stripe_events itself is a platform-only ledger
      // (migration 021).
      const isNew = await withPlatform((q) =>
        q.exec(
          `INSERT INTO stripe_events (stripe_event_id, event_type) VALUES ($1, $2)
           ON CONFLICT (stripe_event_id) DO NOTHING`,
          [event.id, event.type],
        ),
      );
      if (isNew === 0) {
        return reply.status(200).send({ received: true, deduped: true });
      }

      try {
        switch (event.type) {
          case 'checkout.session.completed': {
            const session = event.data.object as Stripe.Checkout.Session;
            if (typeof session.subscription === 'string') {
              await syncSubscriptionFromStripe(session.subscription);
            }
            break;
          }
          case 'customer.subscription.updated':
          case 'customer.subscription.deleted': {
            const subscription = event.data.object as Stripe.Subscription;
            await syncSubscriptionFromStripe(subscription.id);
            break;
          }
          case 'invoice.payment_failed': {
            // Invoice.subscription was removed in favor of this nested path
            // in this API version — verified against the installed stripe
            // package's own types, not assumed.
            const invoice = event.data.object as Stripe.Invoice;
            const subField = invoice.parent?.subscription_details?.subscription;
            const subId = typeof subField === 'string' ? subField : subField?.id;
            if (subId) await syncSubscriptionFromStripe(subId);
            await notifyBillingEmail(invoice, 'payment_failed');
            break;
          }
          case 'invoice.paid': {
            await notifyBillingEmail(event.data.object as Stripe.Invoice, 'paid');
            break;
          }
          default:
            break; // acknowledged, not otherwise handled — Stripe sends many more event types than we subscribe to in the dashboard, but a broader "listen to everything" webhook config would land here too.
        }
      } catch (err) {
        req.log.error({ err, eventType: event.type, eventId: event.id }, 'billing webhook handler failed');
        return reply.status(500).send(); // real failure: let Stripe retry, not a permanent 2xx ack of a half-applied change
      }

      return reply.status(200).send({ received: true });
    });
  });
}
