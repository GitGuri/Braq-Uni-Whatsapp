import express from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as broadcastsController from '../controllers/broadcasts.controller.js';

export const broadcastsRouter = express.Router();
broadcastsRouter.use(requireAuth);

broadcastsRouter.get('/',                  broadcastsController.list);
broadcastsRouter.post('/delay',            broadcastsController.delay);
broadcastsRouter.post('/busy',             broadcastsController.busy);
broadcastsRouter.post('/custom',           broadcastsController.custom);
broadcastsRouter.post('/upload-attachment', broadcastsController.uploadBroadcastAttachment);
