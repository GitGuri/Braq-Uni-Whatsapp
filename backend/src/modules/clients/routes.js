import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import * as clientsController from './controller.js';

export const clientsRouter = express.Router();
clientsRouter.use(requireAuth);

clientsRouter.get('/', clientsController.list);
clientsRouter.get('/:id', clientsController.getById);
clientsRouter.patch('/:id', clientsController.update);
clientsRouter.patch('/:id/account-terms', requirePermission('client.terms'), clientsController.setAccountTerms);
clientsRouter.post('/:id/conversation', clientsController.openConversation);
