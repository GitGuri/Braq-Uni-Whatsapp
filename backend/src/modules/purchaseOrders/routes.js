import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import * as purchaseOrdersController from './controller.js';

export const purchaseOrdersRouter = express.Router();
purchaseOrdersRouter.use(requireAuth);

purchaseOrdersRouter.get('/', purchaseOrdersController.list);
// Recording a PO creates an order — admin/manager only (per README)
purchaseOrdersRouter.post('/', requirePermission('po.create'), purchaseOrdersController.create);
