import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import * as ctrl from '../controllers/schoolCatalog.controller.js';

export const schoolCatalogRouter = Router();

schoolCatalogRouter.use(requireAuth);

schoolCatalogRouter.get('/',           ctrl.list);
schoolCatalogRouter.get('/schools',    ctrl.listSchools);
schoolCatalogRouter.post('/',          requireRole('admin', 'manager'), ctrl.create);
schoolCatalogRouter.patch('/:id',      requireRole('admin', 'manager'), ctrl.update);
schoolCatalogRouter.delete('/:id',     requireRole('admin', 'manager'), ctrl.remove);
