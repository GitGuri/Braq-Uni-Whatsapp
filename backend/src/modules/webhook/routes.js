import express from 'express';
import * as webhookController from './controller.js';

export const webhookRouter = express.Router();

webhookRouter.get('/', webhookController.verify);
// JSON bodies are parsed (and kept raw in req.rawBody) by the app-level express.json.
// Any other content type is read raw here so its signature can still be checked.
webhookRouter.post('/', express.raw({ type: () => true, limit: '1mb' }), webhookController.receive);
