import * as analyticsService from '../services/analytics.service.js';
import { logger } from '../utils/logger.js';

function handleError(res, err) {
  logger.error('Analytics error', { error: err.message });
  res.status(500).json({ error: 'Analytics query failed' });
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
    const clients = await analyticsService.getTopClients(parseInt(req.query.limit) || 10);
    res.json({ clients });
  } catch (err) { handleError(res, err); }
}

export async function bestProducts(req, res) {
  try {
    const products = await analyticsService.getBestSellingProducts(parseInt(req.query.limit) || 10);
    res.json({ products });
  } catch (err) { handleError(res, err); }
}
