import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import { uploadSizeFile } from '../middleware/upload.js';
import * as ordersController from '../controllers/orders.controller.js';

export const ordersRouter = express.Router();
ordersRouter.use(requireAuth);

ordersRouter.get('/', ordersController.list);
ordersRouter.get('/:id', ordersController.getById);
ordersRouter.post('/', ordersController.create);
ordersRouter.post('/:id/advance', ordersController.advance);
ordersRouter.post('/:id/delay', ordersController.delay);
ordersRouter.patch('/:id/assign', ordersController.assign);

ordersRouter.post('/:id/payments', ordersController.recordPayment);
ordersRouter.get('/:id/payments', ordersController.listPayments);

ordersRouter.post('/:id/sizes/upload', (req, res, next) => {
  uploadSizeFile(req, res, (err) => (err ? res.status(400).json({ error: err.message }) : next()));
}, ordersController.uploadSizes);
ordersRouter.get('/:id/sizes', ordersController.listSizes);
