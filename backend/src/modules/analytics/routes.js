import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import * as analyticsController from './controller.js';

export const analyticsRouter = express.Router();
analyticsRouter.use(requireAuth, requirePermission('analytics.view'));

analyticsRouter.get('/revenue',      analyticsController.revenue);
analyticsRouter.get('/top-clients',  analyticsController.topClients);
analyticsRouter.get('/top-products', analyticsController.bestProducts);
