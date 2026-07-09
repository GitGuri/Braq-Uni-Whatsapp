import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as analyticsController from '../controllers/analytics.controller.js';

export const analyticsRouter = express.Router();
analyticsRouter.use(requireAuth);

analyticsRouter.get('/revenue',      analyticsController.revenue);
analyticsRouter.get('/top-clients',  analyticsController.topClients);
analyticsRouter.get('/top-products', analyticsController.bestProducts);
