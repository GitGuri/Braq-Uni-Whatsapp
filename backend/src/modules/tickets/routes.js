import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { isUuid } from '../../core/errors.js';
import * as ticketsController from './controller.js';

export const ticketsRouter = express.Router();
ticketsRouter.use(requireAuth);

ticketsRouter.param('id', (req, res, next, id) =>
  isUuid(id) ? next() : res.status(400).json({ error: 'Invalid ticket id' }));

ticketsRouter.get('/',         ticketsController.list);
ticketsRouter.post('/',        ticketsController.create);
ticketsRouter.get('/:id',      ticketsController.getById);
ticketsRouter.patch('/:id',    ticketsController.update);
ticketsRouter.post('/:id/claim', ticketsController.claim);
