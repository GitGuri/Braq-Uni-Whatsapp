import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as ordersController from '../controllers/orders.controller.js';

export const ordersRouter = express.Router();
ordersRouter.use(requireAuth);

ordersRouter.get('/kpis',                  ordersController.kpis);
ordersRouter.get('/',                      ordersController.list);
ordersRouter.get('/:id',                   ordersController.getById);
ordersRouter.post('/',                     ordersController.create);
ordersRouter.post('/:id/advance',          ordersController.advance);
ordersRouter.patch('/:id/hold',            ordersController.hold);
ordersRouter.patch('/:id/assign',          ordersController.assign);
ordersRouter.post('/:id/payments',         ordersController.recordPayment);
ordersRouter.get('/:id/payments',          ordersController.listPayments);
ordersRouter.patch('/:id/materials',       ordersController.updateMaterials);
ordersRouter.post('/:id/proof',            ordersController.sendProof);
ordersRouter.patch('/:id/proof/status',    ordersController.updateProofStatus);
ordersRouter.get('/:id/size-run-sheet',    ordersController.sizeRunSheet);

// Quotation conversion — :id is the quotation ID
ordersRouter.post('/convert-from-quotation/:id', ordersController.convertFromQuotation);
