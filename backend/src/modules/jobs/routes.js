import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { asyncHandler, uuidParam } from '../../core/http.js';
import { isUuid } from '../../core/errors.js';
import * as jobs from './service.js';

export const jobsRouter = express.Router();
jobsRouter.use(requireAuth);

// GET /api/jobs?state=&owner=me|unassigned&overdue=true&search=&page=&limit=
jobsRouter.get('/', asyncHandler(async (req, res) => {
  res.json(await jobs.listJobs(req.query, req.staff));
}));

// GET /api/jobs/by-order/:orderId → { orderId, quotationId }
jobsRouter.get('/by-order/:orderId', asyncHandler(async (req, res) => {
  if (!isUuid(req.params.orderId)) return res.status(400).json({ error: 'Invalid order id' });
  res.json(await jobs.jobForOrder(req.params.orderId));
}));

// GET /api/jobs/:quotationId → the full job
jobsRouter.param('quotationId', uuidParam('quotation'));
jobsRouter.get('/:quotationId', asyncHandler(async (req, res) => {
  res.json(await jobs.getJob(req.params.quotationId, req.staff));
}));
