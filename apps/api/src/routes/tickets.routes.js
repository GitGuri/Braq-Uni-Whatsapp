import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as ticketsController from '../controllers/tickets.controller.js';

export const ticketsRouter = express.Router();
ticketsRouter.use(requireAuth);

ticketsRouter.get('/', ticketsController.list);
ticketsRouter.get('/:id', ticketsController.getById);
ticketsRouter.patch('/:id', ticketsController.update);
