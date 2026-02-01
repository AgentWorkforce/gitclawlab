/**
 * ClawRunner API Server
 */

import express, { Request, Response, NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { nangoAuthRouter } from './api/nango-auth.js';
import { dashboardRouter } from './app/dashboard.js';
import { authPagesRouter } from './app/auth-pages.js';

const app = express();

// Cookie parser for session handling
app.use(cookieParser());

// Middleware to capture raw body for webhook signature verification
app.use(express.json({
  verify: (req: Request & { rawBody?: string }, _res, buf) => {
    req.rawBody = buf.toString();
  },
}));

// Mount Nango auth routes
app.use('/api/auth/nango', nangoAuthRouter);
app.use('/api/dashboard', dashboardRouter);

// Mount auth pages (login, dashboard UI, session handling)
app.use('/', authPagesRouter);

// Root redirect to login
app.get('/', (_req: Request, res: Response) => {
  res.redirect('/login');
});

// Health check endpoint
app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// Error handler
app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error('[server] Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`[server] ClawRunner API listening on port ${PORT}`);
});

export { app };
