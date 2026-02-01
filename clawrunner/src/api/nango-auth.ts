/**
 * Nango Auth API Routes for ClawRunner
 *
 * Handles GitHub OAuth via Nango for the runner application.
 */

import { Router, Request, Response } from 'express';
import { randomUUID } from 'crypto';
import { nangoService, NANGO_INTEGRATION } from '../services/nango.js';

export const nangoAuthRouter = Router();

// In-memory store for pending logins (connectionId -> user info)
// In production, this should be replaced with a database
const pendingLogins = new Map<string, {
  userId: string;
  githubId: string;
  githubUsername: string;
  email?: string;
  avatarUrl?: string;
  createdAt: Date;
}>();

// Clean up old pending logins (older than 10 minutes)
setInterval(() => {
  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
  for (const [connectionId, data] of pendingLogins.entries()) {
    if (data.createdAt < tenMinutesAgo) {
      pendingLogins.delete(connectionId);
    }
  }
}, 60 * 1000); // Run every minute

/**
 * GET /api/auth/nango/login-session
 * Create a Nango connect session for GitHub login
 */
nangoAuthRouter.get('/login-session', async (req: Request, res: Response) => {
  try {
    const tempUserId = randomUUID();
    const session = await nangoService.createConnectSession({ id: tempUserId });

    res.json({ sessionToken: session.token, tempUserId });
  } catch (error) {
    console.error('[nango-auth] Error creating login session:', error);
    res.status(500).json({ error: 'Failed to create login session' });
  }
});

/**
 * GET /api/auth/nango/login-status/:connectionId
 * Poll for login completion after Nango connect UI
 */
nangoAuthRouter.get('/login-status/:connectionId', async (req: Request, res: Response) => {
  const connectionId = req.params.connectionId;

  try {
    // Check if we have pending login data for this connection
    const loginData = pendingLogins.get(connectionId);
    if (!loginData) {
      return res.json({ ready: false });
    }

    // Clear the pending login data
    pendingLogins.delete(connectionId);

    // Return the user info
    res.json({
      ready: true,
      user: {
        id: loginData.userId,
        githubId: loginData.githubId,
        githubUsername: loginData.githubUsername,
        email: loginData.email,
        avatarUrl: loginData.avatarUrl,
      },
    });
  } catch (error) {
    console.error('[nango-auth] Error checking login status:', error);
    res.status(500).json({ error: 'Failed to check login status' });
  }
});

/**
 * POST /api/auth/nango/webhook
 * Handle Nango webhooks for auth events
 */
nangoAuthRouter.post('/webhook', async (req: Request, res: Response) => {
  const rawBody = (req as Request & { rawBody?: string }).rawBody || JSON.stringify(req.body);

  console.log(`[nango-webhook] Content-Type: ${req.headers['content-type']}`);
  console.log(`[nango-webhook] Body keys: ${Object.keys(req.body || {}).join(', ')}`);

  // SECURITY: Always verify webhook signature - reject unsigned requests
  const hasSignature = req.headers['x-nango-signature'] || req.headers['x-nango-hmac-sha256'];
  if (!hasSignature) {
    console.error('[nango-webhook] Missing signature header - rejecting unsigned webhook');
    return res.status(401).json({ error: 'Missing signature' });
  }
  if (!nangoService.verifyWebhookSignature(rawBody, req.headers as Record<string, string | string[] | undefined>)) {
    console.error('[nango-webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const payload = req.body;
  console.log(`[nango-webhook] Received ${payload.type} event`);

  try {
    switch (payload.type) {
      case 'auth':
        await handleAuthWebhook(payload);
        break;

      case 'sync':
        console.log('[nango-webhook] Sync event received');
        break;

      default:
        console.log(`[nango-webhook] Unhandled event type: ${payload.type}`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('[nango-webhook] Error processing webhook:', error);
    res.status(500).json({ error: 'Failed to process webhook' });
  }
});

/**
 * Handle Nango auth webhook
 */
async function handleAuthWebhook(payload: {
  type: 'auth';
  connectionId: string;
  providerConfigKey: string;
  endUser?: { id?: string; email?: string };
}): Promise<void> {
  const { connectionId, providerConfigKey, endUser } = payload;

  console.log(`[nango-webhook] Auth event for ${providerConfigKey} (${connectionId})`);

  // Only process our github-runner integration
  if (providerConfigKey !== NANGO_INTEGRATION) {
    console.log(`[nango-webhook] Ignoring auth for different integration: ${providerConfigKey}`);
    return;
  }

  try {
    // Get GitHub user info via Nango proxy
    const githubUser = await nangoService.getGithubUser(connectionId);
    const githubId = String(githubUser.id);

    console.log(`[nango-webhook] GitHub user authenticated: ${githubUser.login}`);

    // Store pending login data for polling
    const userId = endUser?.id || randomUUID();
    pendingLogins.set(connectionId, {
      userId,
      githubId,
      githubUsername: githubUser.login,
      email: githubUser.email,
      avatarUrl: githubUser.avatar_url,
      createdAt: new Date(),
    });

    // Update connection with user info
    await nangoService.updateEndUser(connectionId, {
      id: userId,
      email: githubUser.email,
    });

    console.log(`[nango-webhook] Login ready for polling: ${connectionId}`);
  } catch (error) {
    console.error(`[nango-webhook] Error processing auth webhook:`, error);
    throw error;
  }
}
