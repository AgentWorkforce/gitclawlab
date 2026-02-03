import express, { Express, Request, Response, NextFunction } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, existsSync } from 'fs';
import reposRouter from './routes/repos.js';
import deployRouter from './routes/deploy.js';
import webhooksRouter from './routes/webhooks.js';
import agentsRouter from './routes/agents.js';
import stripeRouter from './routes/stripe.js';
import { getRepository, getLatestSuccessfulDeployment } from '../db/schema.js';

// In-memory cache for deployment URLs (5 minute TTL)
const deploymentUrlCache = new Map<string, { url: string; expires: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getDeploymentUrl(appName: string): Promise<string | null> {
  // Check cache first
  const cached = deploymentUrlCache.get(appName);
  if (cached && cached.expires > Date.now()) {
    return cached.url;
  }

  // Look up from database
  const repo = await getRepository(appName);
  if (!repo) return null;

  const deployment = await getLatestSuccessfulDeployment(repo.id);
  if (!deployment?.url) return null;

  // Cache the result
  deploymentUrlCache.set(appName, {
    url: deployment.url,
    expires: Date.now() + CACHE_TTL,
  });

  return deployment.url;
}

// Subdomains that should NOT be proxied (handled by main app)
const MAIN_SUBDOMAINS = ['www', 'api', 'git', 'ssh', ''];
const BASE_DOMAIN = process.env.BASE_DOMAIN || 'gitclawlab.com';

// Simple in-memory rate limiter
const rateLimitStore = new Map<string, { count: number; resetTime: number }>();

function rateLimiter(windowMs: number, maxRequests: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const record = rateLimitStore.get(key);

    if (!record || now > record.resetTime) {
      rateLimitStore.set(key, { count: 1, resetTime: now + windowMs });
      next();
      return;
    }

    if (record.count >= maxRequests) {
      res.status(429).json({ error: 'Too many requests. Please try again later.' });
      return;
    }

    record.count++;
    next();
  };
}

// Clean up expired entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of rateLimitStore.entries()) {
    if (now > record.resetTime) {
      rateLimitStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

// Extend Express Request to include rawBody for Stripe webhook verification
declare global {
  namespace Express {
    interface Request {
      rawBody?: Buffer;
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..', '..');

/**
 * Create and configure the Express API server
 */
export function createServer(): Express {
  const app = express();

  /**
   * Subdomain proxy middleware - routes *.gitclawlab.com to Railway deployments
   * This runs FIRST before any other middleware
   */
  app.use(async (req: Request, res: Response, next: NextFunction) => {
    const host = req.hostname || req.headers.host?.split(':')[0] || '';

    // Extract subdomain
    const parts = host.split('.');
    if (parts.length < 2) {
      next();
      return;
    }

    // Check if this is a subdomain we should proxy
    const subdomain = parts[0];
    const isSubdomain = host.endsWith(BASE_DOMAIN) && !MAIN_SUBDOMAINS.includes(subdomain);

    if (!isSubdomain) {
      next();
      return;
    }

    // Look up the Railway URL for this app
    try {
      const railwayUrl = await getDeploymentUrl(subdomain);

      if (!railwayUrl) {
        res.status(404).send(`App "${subdomain}" not found or not deployed`);
        return;
      }

      // Proxy the request to Railway
      const targetUrl = new URL(req.originalUrl, railwayUrl);

      const proxyResponse = await fetch(targetUrl.toString(), {
        method: req.method,
        headers: {
          ...Object.fromEntries(
            Object.entries(req.headers)
              .filter(([key]) => !['host', 'connection'].includes(key.toLowerCase()))
              .map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value || ''])
          ),
          'Host': new URL(railwayUrl).host,
          'X-Forwarded-Host': host,
          'X-Forwarded-Proto': 'https',
        },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : req.body,
      });

      // Forward response headers
      proxyResponse.headers.forEach((value, key) => {
        if (!['transfer-encoding', 'connection'].includes(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });

      res.status(proxyResponse.status);

      // Stream the response body
      if (proxyResponse.body) {
        const reader = proxyResponse.body.getReader();
        const pump = async () => {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
          }
          res.end();
        };
        await pump();
      } else {
        res.end();
      }
    } catch (error) {
      console.error('Proxy error:', error);
      res.status(502).send('Bad Gateway');
    }
  });

  // IMPORTANT: Stripe webhook needs raw body for signature verification
  // This must be registered BEFORE express.json() middleware
  app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }), (req, res, next) => {
    // Store the raw body for signature verification
    req.rawBody = req.body;
    next();
  });

  // Middleware
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Security headers
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.header('X-Content-Type-Options', 'nosniff');
    res.header('X-Frame-Options', 'DENY');
    res.header('X-XSS-Protection', '1; mode=block');
    res.header('Referrer-Policy', 'strict-origin-when-cross-origin');
    if (process.env.NODE_ENV === 'production') {
      res.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    next();
  });

  // Rate limiting - 100 requests per minute for general API
  app.use('/api', rateLimiter(60 * 1000, 100));

  // Stricter rate limit for agent registration - 5 per minute
  app.use('/api/agents', rateLimiter(60 * 1000, 5));

  // CORS headers for API access - configurable origins
  const allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
    : ['http://localhost:3000', 'http://localhost:5173'];

  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;

    // In development or if explicitly configured, allow the requesting origin
    if (origin && (process.env.NODE_ENV !== 'production' || allowedOrigins.includes(origin))) {
      res.header('Access-Control-Allow-Origin', origin);
    }

    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, X-Admin-Key');
    res.header('Access-Control-Allow-Credentials', 'true');

    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }

    next();
  });

  // Request logging
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
      const duration = Date.now() - start;
      console.log(`${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
    });
    next();
  });

  // Health check endpoint
  app.get('/health', (req: Request, res: Response) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  // Serve SKILL.md for agents
  app.get('/SKILL.md', (req: Request, res: Response) => {
    const skillPath = join(projectRoot, 'SKILL.md');
    if (existsSync(skillPath)) {
      res.type('text/markdown').send(readFileSync(skillPath, 'utf-8'));
    } else {
      res.status(404).send('SKILL.md not found');
    }
  });

  // Landing page
  app.get('/', (req: Request, res: Response) => {
    const landingPath = join(projectRoot, 'www', 'landing.html');
    if (existsSync(landingPath)) {
      res.type('text/html').send(readFileSync(landingPath, 'utf-8'));
    } else {
      res.redirect('/app');
    }
  });

  // Dashboard app (React)
  app.use('/app', express.static(join(projectRoot, 'www', 'dist')));
  app.get('/app/*', (req: Request, res: Response) => {
    const indexPath = join(projectRoot, 'www', 'dist', 'index.html');
    if (existsSync(indexPath)) {
      res.type('text/html').send(readFileSync(indexPath, 'utf-8'));
    } else {
      res.status(404).send('Dashboard not built. Run: cd www && npm run build');
    }
  });

  // API version info
  app.get('/api', (req: Request, res: Response) => {
    res.json({
      name: 'GitClawLab API',
      version: '0.1.0',
      docs: '/SKILL.md',
      endpoints: {
        agents: '/api/agents',
        repos: '/api/repos',
        deployments: '/api/deployments',
        webhooks: '/api/webhooks',
        stripe: '/api/stripe',
        health: '/health',
      },
    });
  });

  /**
   * GET /api/lookup/:name - Get Railway URL for an app (used by Cloudflare Worker)
   * This is an internal endpoint for subdomain routing.
   */
  app.get('/api/lookup/:name', async (req: Request, res: Response) => {
    const { name } = req.params;

    try {
      const repo = await getRepository(name);
      if (!repo) {
        res.status(404).json({ error: 'App not found' });
        return;
      }

      const deployment = await getLatestSuccessfulDeployment(repo.id);
      if (!deployment || !deployment.url) {
        res.status(404).json({ error: 'No successful deployment found' });
        return;
      }

      res.json({ url: deployment.url, repo: name });
    } catch (error) {
      console.error('Lookup error:', error);
      res.status(500).json({ error: 'Lookup failed' });
    }
  });

  // Mount routes
  app.use('/api/agents', agentsRouter);
  app.use('/api/repos', reposRouter);
  app.use('/api', deployRouter);
  app.use('/api', webhooksRouter);
  app.use('/api/stripe', stripeRouter);

  // 404 handler
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'Not found' });
  });

  // Error handler
  app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export default createServer;
