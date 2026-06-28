import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as purchaseOrdersController from '../controllers/purchaseOrders.controller.js';

export const purchaseOrdersRouter = express.Router();
purchaseOrdersRouter.use(requireAuth);

purchaseOrdersRouter.get('/', purchaseOrdersController.list);
purchaseOrdersRouter.post('/', purchaseOrdersController.create);
