import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './core/config.js';
import { logger, requestContext } from './core/logger.js';
import { errorMiddleware } from './core/errors.js';
import { PgRateLimitStore } from './core/rateLimitStore.js';
import { catchAsyncRoutes } from './core/http.js';

// Routers
import { webhookRouter }        from './modules/webhook/routes.js';
import { ordersRouter }         from './modules/orders/routes.js';
import { staffRouter }          from './modules/staff/routes.js';
import { clientsRouter }        from './modules/clients/routes.js';
import { productsRouter }       from './modules/catalog/routes.js';
import { quotationsRouter }     from './modules/quotations/routes.js';
import { ticketsRouter }        from './modules/tickets/routes.js';
import { conversationsRouter }  from './modules/conversations/routes.js';
import { settingsRouter }       from './modules/settings/routes.js';
import { analyticsRouter }      from './modules/analytics/routes.js';
import { broadcastsRouter }     from './modules/broadcasts/routes.js';
import { purchaseOrdersRouter } from './modules/purchaseOrders/routes.js';
import { schoolCatalogRouter }  from './modules/catalog/routes.js';
import { jobsRouter }           from './modules/jobs/routes.js';
import { metaRouter }           from './modules/meta/routes.js';

/** Build the Express app (no listening, no DB work) — used by index.js and tests. */
export function createApp() {
  const app = express();

  // Behind a reverse proxy (Render, Nginx, etc.) set TRUST_PROXY so rate limits see real client IPs
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(requestContext);
  app.use(helmet());
  app.use(cors({
    origin: config.env === 'production'
      ? config.corsOrigins
      : ['http://localhost:5173', 'http://localhost:3001'],
    credentials: true,
    exposedHeaders: ['X-Request-Id'],
  }));

  // General API limit — sized for a dashboard that polls several endpoints per minute
  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    standardHeaders: true,
    message: { error: 'Too many requests, please try again later' },
  });
  // Brute-force guard: only failed logins count, per IP + email. Counted in
  // Postgres (rate_limits) so the limit holds across API instances.
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 10,
    skipSuccessfulRequests: true,
    store: new PgRateLimitStore({ prefix: 'login:' }),
    keyGenerator: (req) => `${req.ip}|${String(req.body?.email || '').toLowerCase()}`,
    message: { error: 'Too many failed login attempts, please try again later' },
  });
  app.use('/api', apiLimiter);
  // Keep the raw body so the webhook can verify Meta's X-Hub-Signature-256
  app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
  app.use('/api/staff/login', loginLimiter);

  app.use((req, _res, next) => {
    logger.debug(`${req.method} ${req.path}`);
    next();
  });

  // ── Routes ──────────────────────────────────────────────────────────────────
  // Every handler's rejection / throw reaches errorMiddleware (never an
  // unhandled rejection that would take the process down).
  for (const r of [webhookRouter, ordersRouter, staffRouter, clientsRouter, productsRouter, quotationsRouter,
    ticketsRouter, conversationsRouter, settingsRouter, analyticsRouter, broadcastsRouter, purchaseOrdersRouter,
    schoolCatalogRouter, jobsRouter, metaRouter]) catchAsyncRoutes(r);

  app.use('/webhook',             webhookRouter);
  app.use('/api/orders',          ordersRouter);
  app.use('/api/staff',           staffRouter);
  app.use('/api/clients',         clientsRouter);
  app.use('/api/products',        productsRouter);
  app.use('/api/quotations',      quotationsRouter);
  app.use('/api/tickets',         ticketsRouter);
  app.use('/api/conversations',   conversationsRouter);
  app.use('/api/settings',        settingsRouter);
  app.use('/api/analytics',       analyticsRouter);
  app.use('/api/broadcasts',      broadcastsRouter);
  app.use('/api/purchase-orders', purchaseOrdersRouter);
  app.use('/api/school-catalog',  schoolCatalogRouter);
  app.use('/api/jobs',            jobsRouter);
  app.use('/api/meta',            metaRouter);

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'Braq Connect API', timestamp: new Date().toISOString() });
  });

  app.use((_req, res) => res.status(404).json({ error: 'Route not found' }));

  app.use(errorMiddleware);

  return app;
}
