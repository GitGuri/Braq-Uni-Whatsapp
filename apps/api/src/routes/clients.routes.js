import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as clientsController from '../controllers/clients.controller.js';

export const clientsRouter = express.Router();
clientsRouter.use(requireAuth);

clientsRouter.get('/', clientsController.list);
clientsRouter.get('/:id', clientsController.getById);
clientsRouter.patch('/:id', clientsController.update);
