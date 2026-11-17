import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { isUuid } from '../../core/errors.js';
import * as quotationsController from './controller.js';

export const quotationsRouter = express.Router();

// Malformed ids are a client error, not a 500 from Postgres.
quotationsRouter.param('id', (req, res, next, id) =>
  isUuid(id) ? next() : res.status(400).json({ error: 'Invalid quotation id' }));

// Public — Meta's WhatsApp document fetcher hits this with no auth (drafts: signed-in staff only).
quotationsRouter.get('/:id/pdf', quotationsController.getPdf);

quotationsRouter.use(requireAuth);
quotationsRouter.get('/',           quotationsController.list);
quotationsRouter.post('/',          quotationsController.create);
quotationsRouter.get('/:id',        quotationsController.getById);
quotationsRouter.put('/:id',        quotationsController.saveDraft);
quotationsRouter.post('/:id/approve',   quotationsController.approve);
quotationsRouter.patch('/:id/status',  quotationsController.updateStatus);
quotationsRouter.post('/:id/claim',    quotationsController.claim);
quotationsRouter.post('/:id/resend',   quotationsController.resend);
