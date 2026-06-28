import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as productsController from '../controllers/products.controller.js';

export const productsRouter = express.Router();
productsRouter.use(requireAuth);

productsRouter.get('/', productsController.list);
productsRouter.get('/:id', productsController.getById);
productsRouter.post('/', requireRole('admin', 'manager'), productsController.create);
productsRouter.patch('/:id', requireRole('admin', 'manager'), productsController.update);
