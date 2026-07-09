import express from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as staffController from '../controllers/staff.controller.js';

export const staffRouter = express.Router();

staffRouter.post('/login', staffController.login);
staffRouter.get('/me', requireAuth, staffController.me);
staffRouter.get('/', requireAuth, requireRole('admin', 'manager'), staffController.list);
staffRouter.post('/', requireAuth, requireRole('admin'), staffController.create);
staffRouter.delete('/:id', requireAuth, requireRole('admin'), staffController.remove);
