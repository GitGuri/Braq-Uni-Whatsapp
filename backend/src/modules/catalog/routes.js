// Catalog routes: the general product catalog (/api/products) and the
// per-school uniform price list (/api/school-catalog). Reads: any staff;
// writes: product.write / catalog.write (admin, manager).
import express from 'express';
import { requireAuth } from '../../middleware/auth.js';
import { requirePermission } from '../../core/rbac.js';
import { uuidParam } from '../../core/http.js';
import * as productsController from './products.controller.js';
import * as ctrl from './schoolCatalog.controller.js';

// ── /api/products ────────────────────────────────────────────────────────────
export const productsRouter = express.Router();
productsRouter.use(requireAuth);
productsRouter.param('id', uuidParam('product'));

productsRouter.get('/', productsController.list);
productsRouter.get('/:id', productsController.getById);
productsRouter.post('/', requirePermission('product.write'), productsController.create);
productsRouter.patch('/:id', requirePermission('product.write'), productsController.update);

// ── /api/school-catalog ──────────────────────────────────────────────────────
export const schoolCatalogRouter = express.Router();
schoolCatalogRouter.use(requireAuth);
schoolCatalogRouter.param('id', uuidParam('school catalog entry'));

schoolCatalogRouter.get('/',           ctrl.list);
schoolCatalogRouter.get('/schools',    ctrl.listSchools);
schoolCatalogRouter.post('/',          requirePermission('catalog.write'), ctrl.create);
schoolCatalogRouter.patch('/:id',      requirePermission('catalog.write'), ctrl.update);
schoolCatalogRouter.delete('/:id',     requirePermission('catalog.write'), ctrl.remove);
