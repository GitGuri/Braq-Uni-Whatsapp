import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import * as staffController from './controller.js';

export const staffRouter = express.Router();

staffRouter.post('/login', staffController.login);
staffRouter.get('/me', requireAuth, staffController.me);
staffRouter.post('/me/password', requireAuth, staffController.changePassword);
staffRouter.patch('/:id', requireAuth, requirePermission('staff.manage'), staffController.update);
staffRouter.get('/', requireAuth, staffController.list);
staffRouter.post('/', requireAuth, requirePermission('staff.manage'), staffController.create);
staffRouter.delete('/:id', requireAuth, requirePermission('staff.manage'), staffController.remove);
