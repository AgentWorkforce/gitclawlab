import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getDb } from '../../db/schema.js';
import { ulid } from 'ulid';

const router = Router();

// Lazy-initialize Stripe client only when needed and configured
let stripe: Stripe | null = null;

function getStripe(): Stripe | null {
  if (stripe) return stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    return null;
  }
  stripe = new Stripe(key);
  return stripe;
}

// Extend Request type to include rawBody
interface RawBodyRequest extends Request {
  rawBody?: Buffer;
}

// Plan configuration based on landing.html pricing
export const PLANS = {
  free: {
    name: 'Free',
    priceMonthly: 0,
    features: {
      maxRepos: 5,
      maxDeploymentsPerMonth: 10,
      support: 'community',
      resources: 'shared',
    },
  },
  pro: {
    name: 'Pro',
    priceMonthly: 2000, // $20.00 in cents
    features: {
      maxRepos: -1, // unlimited
      maxDeploymentsPerMonth: -1, // unlimited
      support: 'priority',
      customDomains: true,
    },
  },
  team: {
    name: 'Team',
    priceMonthly: 5000, // $50.00 in cents
    features: {
      maxRepos: -1, // unlimited
      maxDeploymentsPerMonth: -1, // unlimited
      support: 'priority',
      customDomains: true,
      agentSeats: 5,
      teamPermissions: true,
      auditLogs: true,
    },
  },
} as const;

export type PlanType = keyof typeof PLANS;

/**
 * POST /api/stripe/webhook - Handle Stripe webhook events
 *
 * IMPORTANT: This route requires raw body access for signature verification.
 * The server.ts must configure express.raw() middleware for this route.
 */
router.post('/webhook', async (req: RawBodyRequest, res: Response) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error('STRIPE_WEBHOOK_SECRET not configured');
    res.status(500).json({ error: 'Webhook not configured' });
    return;
  }

  if (!sig) {
    console.error('Missing stripe-signature header');
    res.status(400).json({ error: 'Missing signature' });
    return;
  }

  let event: Stripe.Event;

  try {
    // Use rawBody for signature verification - this is critical
    const rawBody = req.rawBody || req.body;
    if (!rawBody) {
      console.error('No raw body available for webhook verification');
      res.status(400).json({ error: 'No request body' });
      return;
    }

    const stripeClient = getStripe();
    if (!stripeClient) {
      res.status(503).json({ error: 'Stripe not configured' });
      return;
    }

    event = stripeClient.webhooks.constructEvent(rawBody, sig, webhookSecret);
    console.log(`Stripe webhook received: ${event.id} - ${event.type}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    console.error(`Webhook signature verification failed: ${message}`);
    res.status(400).json({ error: `Webhook signature verification failed: ${message}` });
    return;
  }

  // Handle the event
  try {
    switch (event.type) {
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      case 'invoice.payment_succeeded':
        await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handlePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      case 'checkout.session.completed':
        await handleCheckoutCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      default:
        console.log(`Unhandled event type: ${event.type}`);
    }

    // Always return 200 for received events
    res.json({ received: true, event_id: event.id, event_type: event.type });
  } catch (err) {
    console.error(`Error processing webhook event ${event.id}:`, err);
    // Still return 200 to prevent Stripe from retrying
    res.json({ received: true, event_id: event.id, error: 'Processing error' });
  }
});

/**
 * POST /api/stripe/products/sync - Create/sync Stripe products and prices
 *
 * This endpoint creates the Free, Pro, and Team products in Stripe.
 * Run this once to set up your Stripe products.
 */
router.post('/products/sync', async (req: Request, res: Response) => {
  const adminKey = req.headers['x-admin-key'];

  // Simple admin protection - in production use proper auth
  if (adminKey !== process.env.ADMIN_API_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const stripeClient = getStripe();
  if (!stripeClient) {
    res.status(503).json({ error: 'Stripe not configured. Set STRIPE_SECRET_KEY environment variable.' });
    return;
  }

  try {
    const products: Record<string, { product: Stripe.Product; price: Stripe.Price | null }> = {};

    // Create Pro plan
    const proProduct = await stripeClient.products.create({
      name: 'GitClawLab Pro',
      description: 'Unlimited repositories, unlimited deployments, priority support, custom domains',
      metadata: {
        plan_type: 'pro',
      },
    });

    const proPrice = await stripeClient.prices.create({
      product: proProduct.id,
      unit_amount: PLANS.pro.priceMonthly,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: {
        plan_type: 'pro',
      },
    });

    products.pro = { product: proProduct, price: proPrice };

    // Create Team plan
    const teamProduct = await stripeClient.products.create({
      name: 'GitClawLab Team',
      description: 'Everything in Pro plus 5 agent seats, team permissions, audit logs',
      metadata: {
        plan_type: 'team',
      },
    });

    const teamPrice = await stripeClient.prices.create({
      product: teamProduct.id,
      unit_amount: PLANS.team.priceMonthly,
      currency: 'usd',
      recurring: { interval: 'month' },
      metadata: {
        plan_type: 'team',
      },
    });

    products.team = { product: teamProduct, price: teamPrice };

    // Free tier is handled without Stripe - no product needed

    res.json({
      success: true,
      products: {
        pro: {
          productId: proProduct.id,
          priceId: proPrice.id,
        },
        team: {
          productId: teamProduct.id,
          priceId: teamPrice.id,
        },
      },
      message: 'Products and prices created successfully. Store these IDs in environment variables.',
    });
  } catch (err) {
    console.error('Failed to sync products:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: `Failed to create products: ${message}` });
  }
});

/**
 * GET /api/stripe/plans - Get available plans and their Stripe price IDs
 */
router.get('/plans', (req: Request, res: Response) => {
  res.json({
    plans: {
      free: {
        ...PLANS.free,
        stripePriceId: null, // No Stripe price for free tier
      },
      pro: {
        ...PLANS.pro,
        stripePriceId: process.env.STRIPE_PRO_PRICE_ID || null,
      },
      team: {
        ...PLANS.team,
        stripePriceId: process.env.STRIPE_TEAM_PRICE_ID || null,
      },
    },
  });
});

/**
 * POST /api/stripe/checkout - Create a checkout session
 */
router.post('/checkout', async (req: Request, res: Response) => {
  const { plan, agentId, successUrl, cancelUrl } = req.body;

  if (!plan || !agentId) {
    res.status(400).json({ error: 'plan and agentId are required' });
    return;
  }

  if (plan === 'free') {
    res.status(400).json({ error: 'Free plan does not require checkout' });
    return;
  }

  const stripeClient = getStripe();
  if (!stripeClient) {
    res.status(503).json({ error: 'Stripe not configured' });
    return;
  }

  const priceId = plan === 'pro'
    ? process.env.STRIPE_PRO_PRICE_ID
    : process.env.STRIPE_TEAM_PRICE_ID;

  if (!priceId) {
    res.status(500).json({ error: `Price ID not configured for plan: ${plan}` });
    return;
  }

  try {
    const session = await stripeClient.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: successUrl || `${process.env.APP_URL || 'http://localhost:3000'}/app/billing?success=true`,
      cancel_url: cancelUrl || `${process.env.APP_URL || 'http://localhost:3000'}/app/billing?canceled=true`,
      metadata: {
        agent_id: agentId,
        plan_type: plan,
      },
      subscription_data: {
        metadata: {
          agent_id: agentId,
          plan_type: plan,
        },
      },
    });

    res.json({
      sessionId: session.id,
      url: session.url,
    });
  } catch (err) {
    console.error('Failed to create checkout session:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: `Failed to create checkout session: ${message}` });
  }
});

/**
 * POST /api/stripe/portal - Create a customer portal session for managing subscription
 */
router.post('/portal', async (req: Request, res: Response) => {
  const { customerId, returnUrl } = req.body;

  if (!customerId) {
    res.status(400).json({ error: 'customerId is required' });
    return;
  }

  const stripeClient = getStripe();
  if (!stripeClient) {
    res.status(503).json({ error: 'Stripe not configured' });
    return;
  }

  try {
    const session = await stripeClient.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl || `${process.env.APP_URL || 'http://localhost:3000'}/app/billing`,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('Failed to create portal session:', err);
    const message = err instanceof Error ? err.message : 'Unknown error';
    res.status(500).json({ error: `Failed to create portal session: ${message}` });
  }
});

// Webhook event handlers

async function handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
  console.log(`Subscription created: ${subscription.id}`);

  const agentId = subscription.metadata?.agent_id;
  const planType = subscription.metadata?.plan_type || 'pro';

  if (!agentId) {
    console.error('Subscription created without agent_id metadata');
    return;
  }

  const db = getDb();
  const id = ulid();
  const now = new Date().toISOString();

  // Access period dates from the first subscription item
  const firstItem = subscription.items.data[0] as any;
  const periodStart = firstItem?.current_period_start
    ? new Date(firstItem.current_period_start * 1000).toISOString()
    : now;
  const periodEnd = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000).toISOString()
    : now;

  db.prepare(`
    INSERT INTO subscriptions (id, agent_id, stripe_customer_id, stripe_subscription_id, plan_type, status, current_period_start, current_period_end, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    agentId,
    subscription.customer as string,
    subscription.id,
    planType,
    subscription.status,
    periodStart,
    periodEnd,
    now,
    now
  );

  console.log(`Created subscription record for agent ${agentId}, plan: ${planType}`);
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  console.log(`Subscription updated: ${subscription.id}`);

  const db = getDb();
  const now = new Date().toISOString();

  // Access period dates from the first subscription item
  const firstItem = subscription.items.data[0] as any;
  const periodStart = firstItem?.current_period_start
    ? new Date(firstItem.current_period_start * 1000).toISOString()
    : null;
  const periodEnd = firstItem?.current_period_end
    ? new Date(firstItem.current_period_end * 1000).toISOString()
    : null;

  const updates: string[] = ['status = ?', 'updated_at = ?'];
  const values: any[] = [subscription.status, now];

  if (periodStart) {
    updates.push('current_period_start = ?');
    values.push(periodStart);
  }
  if (periodEnd) {
    updates.push('current_period_end = ?');
    values.push(periodEnd);
  }

  // Check if plan changed
  const newPlanType = subscription.metadata?.plan_type;
  if (newPlanType) {
    updates.push('plan_type = ?');
    values.push(newPlanType);
  }

  values.push(subscription.id);

  db.prepare(`
    UPDATE subscriptions SET ${updates.join(', ')} WHERE stripe_subscription_id = ?
  `).run(...values);

  console.log(`Updated subscription ${subscription.id}, status: ${subscription.status}`);
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  console.log(`Subscription deleted: ${subscription.id}`);

  const db = getDb();
  const now = new Date().toISOString();

  db.prepare(`
    UPDATE subscriptions SET status = 'canceled', updated_at = ? WHERE stripe_subscription_id = ?
  `).run(now, subscription.id);

  console.log(`Marked subscription ${subscription.id} as canceled`);
}

async function handlePaymentSucceeded(invoice: Stripe.Invoice): Promise<void> {
  console.log(`Payment succeeded for invoice: ${invoice.id}`);

  // Cast to any to access subscription property
  const invoiceData = invoice as any;
  if (!invoiceData.subscription) {
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Record the payment
  const paymentId = ulid();
  db.prepare(`
    INSERT INTO payments (id, stripe_invoice_id, stripe_subscription_id, amount, currency, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'succeeded', ?)
  `).run(
    paymentId,
    invoice.id,
    invoiceData.subscription as string,
    invoice.amount_paid,
    invoice.currency,
    now
  );

  console.log(`Recorded payment ${paymentId} for ${invoice.amount_paid / 100} ${invoice.currency.toUpperCase()}`);
}

async function handlePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  console.log(`Payment failed for invoice: ${invoice.id}`);

  // Cast to any to access subscription property
  const invoiceData = invoice as any;
  if (!invoiceData.subscription) {
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();

  // Record the failed payment
  const paymentId = ulid();
  db.prepare(`
    INSERT INTO payments (id, stripe_invoice_id, stripe_subscription_id, amount, currency, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'failed', ?)
  `).run(
    paymentId,
    invoice.id,
    invoiceData.subscription as string,
    invoice.amount_due,
    invoice.currency,
    now
  );

  // Update subscription status
  db.prepare(`
    UPDATE subscriptions SET status = 'past_due', updated_at = ? WHERE stripe_subscription_id = ?
  `).run(now, invoiceData.subscription as string);

  console.log(`Recorded failed payment for subscription ${invoiceData.subscription}`);
}

async function handleCheckoutCompleted(session: Stripe.Checkout.Session): Promise<void> {
  console.log(`Checkout completed: ${session.id}`);

  // Subscription is handled by subscription.created event
  // This is useful for one-time purchases or additional processing

  const agentId = session.metadata?.agent_id;
  if (agentId) {
    console.log(`Checkout completed for agent ${agentId}`);
  }
}

export default router;
