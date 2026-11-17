import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import * as broadcastsController from './controller.js';

export const broadcastsRouter = express.Router();
broadcastsRouter.use(requireAuth);

broadcastsRouter.get('/',                  broadcastsController.list);
// Sending is admin/manager only; the history list stays readable by all staff.
const canSend = requirePermission('broadcast.send');
broadcastsRouter.post('/delay',             canSend, broadcastsController.delay);
broadcastsRouter.post('/busy',              canSend, broadcastsController.busy);
broadcastsRouter.post('/custom',            canSend, broadcastsController.custom);
broadcastsRouter.post('/upload-attachment', canSend, broadcastsController.uploadBroadcastAttachment);
