import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { testConnection } from './db/pool.js';

// Routers
import { webhookRouter }    from './routes/webhook.routes.js';
import { ordersRouter }     from './routes/orders.routes.js';
import { staffRouter }      from './routes/staff.routes.js';
import { clientsRouter }    from './routes/clients.routes.js';
import { broadcastsRouter } from './routes/broadcasts.routes.js';
import { productsRouter }   from './routes/products.routes.js';
import { quotationsRouter } from './routes/quotations.routes.js';
import { purchaseOrdersRouter } from './routes/purchaseOrders.routes.js';
import { ticketsRouter }          from './routes/tickets.routes.js';
import { conversationsRouter }    from './routes/conversations.routes.js';
import { schoolCatalogRouter }    from './routes/schoolCatalog.routes.js';

const app = express();

// ── Security middleware ───────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: config.env === 'production'
    ? ['https://your-dashboard-domain.com']
    : ['http://localhost:5173', 'http://localhost:3001'],
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  message: { error: 'Too many requests, please try again later' },
});
app.use('/api', apiLimiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
app.use(express.json({ limit: '1mb' }));

// ── Request logging ───────────────────────────────────────────────────────────
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/webhook',          webhookRouter);
app.use('/api/orders',       ordersRouter);
app.use('/api/staff',        staffRouter);
app.use('/api/clients',      clientsRouter);
app.use('/api/broadcasts',   broadcastsRouter);
app.use('/api/products',     productsRouter);
app.use('/api/quotations',   quotationsRouter);
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/tickets',          ticketsRouter);
app.use('/api/conversations',    conversationsRouter);
app.use('/api/school-catalog',   schoolCatalogRouter);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', async (_req, res) => {
  res.json({
    status: 'ok',
    service: 'Braq Connect API',
    env: config.env,
    timestamp: new Date().toISOString(),
  });
});

// ── 404 handler ───────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function start() {
  try {
    await testConnection();

    if (config.apiBaseUrl === 'http://localhost:3000') {
      logger.warn(
        'API_BASE_URL is still the localhost default — WhatsApp document links (quotation PDFs) ' +
        'will be unreachable by Meta until this is set to a public HTTPS URL (e.g. your ngrok tunnel).'
      );
    }

    app.listen(config.port, () => {
      logger.info(`Braq Connect API running`, {
        port: config.port,
        env:  config.env,
        webhook: `${config.apiBaseUrl}/webhook`,
      });
    });
  } catch (err) {
    logger.error('Failed to start server', { error: err.message });
    process.exit(1);
  }
}

start();
