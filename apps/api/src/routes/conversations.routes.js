import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as ctrl from '../controllers/conversations.controller.js';

export const conversationsRouter = Router();

conversationsRouter.use(requireAuth);

conversationsRouter.get('/',                      ctrl.list);
conversationsRouter.get('/unread-count',          ctrl.unreadCount);
conversationsRouter.get('/:id',                   ctrl.getById);
conversationsRouter.post('/:id/reply',            ctrl.reply);
conversationsRouter.patch('/:id/takeover',        ctrl.takeover);
conversationsRouter.patch('/:id/handback',        ctrl.handback);
conversationsRouter.patch('/:id/close',           ctrl.close);
conversationsRouter.patch('/:id/assign',          ctrl.assign);
conversationsRouter.patch('/:id/read',            ctrl.markRead);
conversationsRouter.post('/:id/claim',            ctrl.claim);
