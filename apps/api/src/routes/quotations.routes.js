import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as quotationsController from '../controllers/quotations.controller.js';

export const quotationsRouter = express.Router();

// Public — Meta's WhatsApp document fetcher hits this with no auth.
quotationsRouter.get('/:id/pdf', quotationsController.getPdf);

quotationsRouter.use(requireAuth);
quotationsRouter.get('/', quotationsController.list);
quotationsRouter.get('/:id', quotationsController.getById);
