import * as analyticsService from './service.js';
import { sendError } from '../../core/errors.js';

/** ?limit= clamped to 1..100 (garbage → default 10). */
function limitParam(raw) {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? Math.min(100, Math.max(1, n)) : 10;
}

function handleError(res, err) {
  return sendError(res, err, 'Analytics query failed');
}

export async function revenue(req, res) {
  try {
    const [summary, byMonth, conversion, stageBreakdown] = await Promise.all([
      analyticsService.getRevenueSummary(),
      analyticsService.getRevenueByMonth(),
      analyticsService.getQuotationConversionRate(),
      analyticsService.getOrderStageBreakdown(),
    ]);
    res.json({ summary, byMonth, conversion, stageBreakdown });
  } catch (err) { handleError(res, err); }
}

export async function topClients(req, res) {
  try {
    const clients = await analyticsService.getTopClients(limitParam(req.query.limit));
    res.json({ clients });
  } catch (err) { handleError(res, err); }
}

export async function bestProducts(req, res) {
  try {
    const products = await analyticsService.getBestSellingProducts(limitParam(req.query.limit));
    res.json({ products });
  } catch (err) { handleError(res, err); }
}
