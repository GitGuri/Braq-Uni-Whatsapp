import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as broadcastsController from '../controllers/broadcasts.controller.js';

export const broadcastsRouter = express.Router();
broadcastsRouter.use(requireAuth);
broadcastsRouter.use(requireRole('admin', 'manager'));

broadcastsRouter.post('/delay', broadcastsController.delay);
broadcastsRouter.post('/busy', broadcastsController.busy);
