import express from 'express';
import * as webhookController from '../controllers/webhook.controller.js';

export const webhookRouter = express.Router();

webhookRouter.get('/', webhookController.verify);
webhookRouter.post('/', webhookController.receive);
