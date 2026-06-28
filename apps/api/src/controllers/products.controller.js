import { z } from 'zod';
import * as catalogService from '../services/catalog.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

const CLIENT_TYPES = ['retail','school','corporate','hospitality','church','security','government','reseller'];

const CreateProductSchema = z.object({
  category:   z.string().min(1),
  name:       z.string().min(1),
  sizes:      z.array(z.string()).default([]),
  price:      z.number().nonnegative(),
  currency:   z.string().length(3).default('USD'),
  clientType: z.enum(CLIENT_TYPES).optional(),
});

const UpdateProductSchema = z.object({
  category:   z.string().min(1).optional(),
  name:       z.string().min(1).optional(),
  sizes:      z.array(z.string()).optional(),
  price:      z.number().nonnegative().optional(),
  currency:   z.string().length(3).optional(),
  clientType: z.enum(CLIENT_TYPES).optional(),
  isActive:   z.boolean().optional(),
});

function handleError(res, err, fallbackMessage) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallbackMessage, { error: err.message });
  return res.status(500).json({ error: fallbackMessage });
}

export async function list(req, res) {
  try {
    const products = await catalogService.listProducts(req.query);
    res.json({ products });
  } catch (err) {
    handleError(res, err, 'Failed to fetch products');
  }
}

export async function getById(req, res) {
  try {
    const product = await catalogService.getProductById(req.params.id);
    res.json({ product });
  } catch (err) {
    handleError(res, err, 'Failed to fetch product');
  }
}

export async function create(req, res) {
  const parsed = CreateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const product = await catalogService.createProduct(parsed.data);
    res.status(201).json({ product });
  } catch (err) {
    handleError(res, err, 'Failed to create product');
  }
}

export async function update(req, res) {
  const parsed = UpdateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  try {
    const product = await catalogService.updateProduct(req.params.id, parsed.data);
    res.json({ product });
  } catch (err) {
    handleError(res, err, 'Failed to update product');
  }
}
