import { z } from 'zod';
import * as catalogService from './service.js';
import { HttpError, sendError, validationBody } from '../../core/errors.js';
import { logger } from '../../core/logger.js';

const CATEGORIES = ['school_wear','knitwear','medical_wear','outdoor_wear','corporate_wear','safety_wear'];

const CreateProductSchema = z.object({
  category:    z.enum(CATEGORIES),
  name:        z.string().min(1),
  schoolName:  z.string().optional(),
  sizes:       z.array(z.string()).default([]),
  price:       z.number().finite().nonnegative(),
  currency:    z.string().length(3).default('ZAR'),
  description: z.string().optional(),
  isActive:    z.boolean().default(true),
});

const UpdateProductSchema = z.object({
  category:    z.enum(CATEGORIES).optional(),
  name:        z.string().min(1).optional(),
  schoolName:  z.string().nullable().optional(),
  sizes:       z.array(z.string()).optional(),
  price:       z.number().finite().nonnegative().optional(),
  currency:    z.string().length(3).optional(),
  description: z.string().nullable().optional(),
  isActive:    z.boolean().optional(),
});

function handleError(res, err, fallback) {
  return sendError(res, err, fallback);
}

// Query-string booleans: only 'true'/'1' mean true ("false" is a truthy string).
const queryBool = (v) => v === true || v === 'true' || v === '1';

export async function list(req, res) {
  const { category, schoolName, activeOnly } = req.query;
  if (category && !CATEGORIES.includes(category)) {
    return res.status(400).json({ error: `Invalid category: must be one of ${CATEGORIES.join(', ')}` });
  }
  try {
    const products = await catalogService.listProducts({
      category:   category || undefined,
      schoolName: typeof schoolName === 'string' && schoolName ? schoolName : undefined,
      activeOnly: queryBool(activeOnly),
    });
    res.json({ products });
  } catch (err) { handleError(res, err, 'Failed to fetch products'); }
}

export async function getById(req, res) {
  try {
    const product = await catalogService.getProductById(req.params.id);
    res.json({ product });
  } catch (err) { handleError(res, err, 'Failed to fetch product'); }
}

export async function create(req, res) {
  const parsed = CreateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const product = await catalogService.createProduct(parsed.data);
    res.status(201).json({ product });
  } catch (err) { handleError(res, err, 'Failed to create product'); }
}

export async function update(req, res) {
  const parsed = UpdateProductSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));

  try {
    const product = await catalogService.updateProduct(req.params.id, parsed.data);
    res.json({ product });
  } catch (err) { handleError(res, err, 'Failed to update product'); }
}
