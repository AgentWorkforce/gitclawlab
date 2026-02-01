/**
 * Auth Pages - Nango Connect UI Integration
 *
 * Handles login flow using Nango Connect for GitHub OAuth.
 * Flow:
 * 1. User visits /login
 * 2. Click login button -> fetch session token from /api/auth/nango/login-session
 * 3. Redirect to Nango Connect UI or use embedded JS SDK
 * 4. After auth, poll /api/auth/nango/login-status until complete
 * 5. Create session and redirect to dashboard
 */

import { Router, Request, Response } from 'express';
import { userQueries, type User } from '../db/index.js';

export const authPagesRouter = Router();

// Session store (in production, use Redis or database-backed sessions)
const sessions = new Map<string, { userId: string; expiresAt: Date }>();

// Clean up expired sessions every 5 minutes
setInterval(() => {
  const now = new Date();
  for (const [sessionId, data] of Array.from(sessions.entries())) {
    if (data.expiresAt < now) {
      sessions.delete(sessionId);
    }
  }
}, 5 * 60 * 1000);

/**
 * Generate a secure session ID
 */
function generateSessionId(): string {
  const crypto = require('crypto');
  return crypto.randomBytes(32).toString('hex');
}

/**
 * GET /login
 * Render login page with Nango Connect integration
 */
authPagesRouter.get('/login', (_req: Request, res: Response) => {
  const nangoPublicKey = process.env.NANGO_PUBLIC_KEY || '';

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login - ClawRunner</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
    }
    .container {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 16px;
      padding: 48px;
      text-align: center;
      max-width: 400px;
      width: 90%;
    }
    .logo {
      font-size: 48px;
      margin-bottom: 16px;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 8px;
      font-weight: 600;
    }
    .subtitle {
      color: rgba(255, 255, 255, 0.6);
      margin-bottom: 32px;
    }
    .login-btn {
      display: inline-flex;
      align-items: center;
      gap: 12px;
      background: #24292e;
      color: #fff;
      border: none;
      padding: 14px 28px;
      font-size: 16px;
      font-weight: 500;
      border-radius: 8px;
      cursor: pointer;
      transition: all 0.2s;
      width: 100%;
      justify-content: center;
    }
    .login-btn:hover {
      background: #2f363d;
      transform: translateY(-1px);
    }
    .login-btn:disabled {
      opacity: 0.6;
      cursor: not-allowed;
      transform: none;
    }
    .login-btn svg {
      width: 20px;
      height: 20px;
    }
    .status {
      margin-top: 24px;
      padding: 12px;
      border-radius: 8px;
      display: none;
    }
    .status.loading {
      display: block;
      background: rgba(59, 130, 246, 0.2);
      border: 1px solid rgba(59, 130, 246, 0.3);
    }
    .status.error {
      display: block;
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid rgba(239, 68, 68, 0.3);
    }
    .spinner {
      display: inline-block;
      width: 16px;
      height: 16px;
      border: 2px solid rgba(255, 255, 255, 0.3);
      border-top-color: #fff;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-right: 8px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="logo">🦞</div>
    <h1>ClawRunner</h1>
    <p class="subtitle">Sign in to manage your cloud machines</p>

    <button id="loginBtn" class="login-btn">
      <svg viewBox="0 0 16 16" fill="currentColor">
        <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/>
      </svg>
      Continue with GitHub
    </button>

    <div id="status" class="status"></div>
  </div>

  <script src="https://connect.nango.dev/v1/sdk.js"></script>
  <script>
    const NANGO_PUBLIC_KEY = '${nangoPublicKey}';
    const loginBtn = document.getElementById('loginBtn');
    const statusEl = document.getElementById('status');

    function showStatus(message, isError = false) {
      statusEl.className = 'status ' + (isError ? 'error' : 'loading');
      statusEl.innerHTML = isError ? message : '<span class="spinner"></span>' + message;
    }

    function hideStatus() {
      statusEl.className = 'status';
      statusEl.innerHTML = '';
    }

    async function pollLoginStatus(connectionId, maxAttempts = 60) {
      for (let i = 0; i < maxAttempts; i++) {
        try {
          const response = await fetch('/api/auth/nango/login-status/' + connectionId);
          const data = await response.json();

          if (data.ready && data.user) {
            return data.user;
          }

          // Wait 1 second before next poll
          await new Promise(resolve => setTimeout(resolve, 1000));
        } catch (error) {
          console.error('Poll error:', error);
        }
      }
      throw new Error('Login timeout - please try again');
    }

    async function handleLogin() {
      loginBtn.disabled = true;
      showStatus('Initializing login...');

      try {
        // Step 1: Fetch session token from API
        const sessionResponse = await fetch('/api/auth/nango/login-session');
        if (!sessionResponse.ok) {
          throw new Error('Failed to create login session');
        }
        const { sessionToken, tempUserId } = await sessionResponse.json();

        showStatus('Opening GitHub authorization...');

        // Step 2: Open Nango Connect UI
        const nango = new Nango({ connectSessionToken: sessionToken });

        const result = await nango.openConnectUI({
          onEvent: (event) => {
            console.log('[Nango Event]', event);
            if (event.type === 'close') {
              hideStatus();
              loginBtn.disabled = false;
            }
          }
        });

        if (!result || !result.connectionId) {
          throw new Error('Authorization was cancelled or failed');
        }

        showStatus('Completing login...');

        // Step 3: Poll for login completion
        const user = await pollLoginStatus(result.connectionId);

        showStatus('Creating session...');

        // Step 4: Create session
        const createSessionResponse = await fetch('/auth/create-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connectionId: result.connectionId,
            userId: user.id,
            githubId: user.githubId,
            githubUsername: user.githubUsername,
            email: user.email,
            avatarUrl: user.avatarUrl
          })
        });

        if (!createSessionResponse.ok) {
          throw new Error('Failed to create session');
        }

        showStatus('Redirecting to dashboard...');

        // Step 5: Redirect to dashboard
        window.location.href = '/dashboard';

      } catch (error) {
        console.error('Login error:', error);
        showStatus(error.message || 'Login failed. Please try again.', true);
        loginBtn.disabled = false;
      }
    }

    loginBtn.addEventListener('click', handleLogin);
  </script>
</body>
</html>
  `.trim();

  res.type('html').send(html);
});

/**
 * POST /auth/create-session
 * Create a user session after successful Nango authentication
 */
authPagesRouter.post('/auth/create-session', async (req: Request, res: Response) => {
  try {
    const { connectionId, userId, githubId, githubUsername, email, avatarUrl } = req.body;

    if (!githubId || !githubUsername) {
      return res.status(400).json({ error: 'Missing required user information' });
    }

    // Upsert user in database
    const user = await userQueries.upsertFromGithub({
      id: userId,
      githubId: String(githubId),
      githubUsername,
      email,
      avatarUrl,
      nangoConnectionId: connectionId,
    });

    // Create session
    const sessionId = generateSessionId();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    sessions.set(sessionId, { userId: user.id, expiresAt });

    // Set session cookie
    res.cookie('session', sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      expires: expiresAt,
      path: '/',
    });

    res.json({ success: true, user: { id: user.id, githubUsername: user.githubUsername } });
  } catch (error) {
    console.error('[auth-pages] Error creating session:', error);
    res.status(500).json({ error: 'Failed to create session' });
  }
});

/**
 * GET /auth/logout
 * Clear user session and redirect to login
 */
authPagesRouter.get('/auth/logout', (req: Request, res: Response) => {
  const sessionId = req.cookies?.session;
  if (sessionId) {
    sessions.delete(sessionId);
  }

  res.clearCookie('session', { path: '/' });
  res.redirect('/login');
});

/**
 * GET /dashboard
 * Render dashboard page (requires authentication)
 */
authPagesRouter.get('/dashboard', async (req: Request, res: Response) => {
  const sessionId = req.cookies?.session;
  const session = sessionId ? sessions.get(sessionId) : null;

  if (!session || session.expiresAt < new Date()) {
    return res.redirect('/login');
  }

  // Fetch user data
  let user: User | null = null;
  try {
    user = await userQueries.findById(session.userId);
  } catch (error) {
    console.error('[auth-pages] Error fetching user:', error);
  }

  if (!user) {
    sessions.delete(sessionId);
    res.clearCookie('session', { path: '/' });
    return res.redirect('/login');
  }

  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Dashboard - ClawRunner</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
      min-height: 100vh;
      color: #fff;
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 16px 32px;
      background: rgba(255, 255, 255, 0.05);
      border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 20px;
      font-weight: 600;
    }
    .user-info {
      display: flex;
      align-items: center;
      gap: 16px;
    }
    .avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: rgba(255, 255, 255, 0.1);
    }
    .logout-btn {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.2);
      color: #fff;
      padding: 8px 16px;
      border-radius: 6px;
      cursor: pointer;
      font-size: 14px;
    }
    .logout-btn:hover {
      background: rgba(255, 255, 255, 0.1);
    }
    .main {
      padding: 32px;
      max-width: 1200px;
      margin: 0 auto;
    }
    h1 {
      font-size: 28px;
      margin-bottom: 24px;
    }
    .card {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 12px;
      padding: 24px;
      margin-bottom: 24px;
    }
    .card h2 {
      font-size: 18px;
      margin-bottom: 16px;
      color: rgba(255, 255, 255, 0.8);
    }
    .machines-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 16px;
    }
    .machine-card {
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 8px;
      padding: 16px;
    }
    .machine-name {
      font-weight: 500;
      margin-bottom: 8px;
    }
    .machine-status {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 4px;
      font-size: 12px;
      text-transform: uppercase;
    }
    .machine-status.running {
      background: rgba(34, 197, 94, 0.2);
      color: #22c55e;
    }
    .machine-status.stopped {
      background: rgba(239, 68, 68, 0.2);
      color: #ef4444;
    }
    .empty-state {
      text-align: center;
      padding: 48px;
      color: rgba(255, 255, 255, 0.5);
    }
  </style>
</head>
<body>
  <header class="header">
    <div class="logo">
      <span>🦞</span>
      <span>ClawRunner</span>
    </div>
    <div class="user-info">
      ${user.avatarUrl ? `<img src="${user.avatarUrl}" alt="Avatar" class="avatar">` : '<div class="avatar"></div>'}
      <span>${user.githubUsername}</span>
      <a href="/auth/logout" class="logout-btn">Logout</a>
    </div>
  </header>

  <main class="main">
    <h1>Welcome back, ${user.githubUsername}!</h1>

    <div class="card">
      <h2>Your Machines</h2>
      <div id="machines" class="machines-grid">
        <div class="empty-state">Loading machines...</div>
      </div>
    </div>
  </main>

  <script>
    async function loadMachines() {
      try {
        const response = await fetch('/api/dashboard', {
          headers: { 'X-User-Id': '${user.id}' }
        });
        const data = await response.json();

        const machinesEl = document.getElementById('machines');

        if (!data.machines || data.machines.length === 0) {
          machinesEl.innerHTML = '<div class="empty-state">No machines yet. Create your first machine to get started!</div>';
          return;
        }

        machinesEl.innerHTML = data.machines.map(machine => \`
          <div class="machine-card">
            <div class="machine-name">\${machine.name}</div>
            <span class="machine-status \${machine.status}">\${machine.status}</span>
            <div style="margin-top: 8px; font-size: 12px; color: rgba(255,255,255,0.5);">
              \${machine.provider} • \${machine.region || 'N/A'}
            </div>
          </div>
        \`).join('');
      } catch (error) {
        console.error('Error loading machines:', error);
        document.getElementById('machines').innerHTML = '<div class="empty-state">Failed to load machines</div>';
      }
    }

    loadMachines();
  </script>
</body>
</html>
  `.trim();

  res.type('html').send(html);
});

/**
 * Middleware to get current user from session
 */
export function getSessionUser(req: Request): { userId: string } | null {
  const sessionId = req.cookies?.session;
  if (!sessionId) return null;

  const session = sessions.get(sessionId);
  if (!session || session.expiresAt < new Date()) {
    return null;
  }

  return { userId: session.userId };
}

/**
 * Auth middleware for protected routes
 */
export function requireAuth(req: Request, res: Response, next: Function) {
  const user = getSessionUser(req);
  if (!user) {
    return res.redirect('/login');
  }
  (req as Request & { session: { userId: string } }).session = user;
  next();
}
