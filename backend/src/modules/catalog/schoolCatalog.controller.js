import { z } from 'zod';
import * as service from './schoolCatalog.service.js';
import { sendError, validationBody } from '../../core/errors.js';

// Form inputs may send '' / null for "not set" — treat those as absent.
const blankToUndefined = (v) => (v === '' || v === null ? undefined : v);

const price     = z.preprocess(blankToUndefined, z.coerce.number().finite().nonnegative());
const sortOrder = z.preprocess(blankToUndefined, z.coerce.number().int());
const sizes     = z.array(z.string().trim().min(1));

const CreateEntrySchema = z.object({
  schoolName:  z.string().trim().min(1),
  uniformType: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  sizes:       sizes.default([]),
  price,
  currency:    z.string().length(3).default('ZAR'),
  sortOrder:   sortOrder.optional(),
});

const UpdateEntrySchema = z.object({
  schoolName:  z.string().trim().min(1).optional(),
  uniformType: z.string().trim().min(1).optional(),
  description: z.string().nullable().optional(),
  sizes:       sizes.optional(),
  price:       price.optional(),
  currency:    z.string().length(3).optional(),
  isActive:    z.boolean().optional(),
  sortOrder:   sortOrder.optional(),
});

function handleError(res, err, fallback) {
  return sendError(res, err, fallback);
}

export async function list(req, res) {
  try {
    const school = typeof req.query.school === 'string' && req.query.school ? req.query.school : undefined;
    const entries = await service.listAll({ school });
    res.json({ entries });
  } catch (err) {
    handleError(res, err, 'Failed to list school catalog');
  }
}

export async function listSchools(req, res) {
  try {
    const schools = await service.listDistinctSchools();
    res.json({ schools });
  } catch (err) {
    handleError(res, err, 'Failed to list schools');
  }
}

export async function create(req, res) {
  const parsed = CreateEntrySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const entry = await service.create(parsed.data);
    res.status(201).json({ entry });
  } catch (err) {
    handleError(res, err, 'Failed to create school catalog entry');
  }
}

export async function update(req, res) {
  const parsed = UpdateEntrySchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json(validationBody(parsed.error));
  try {
    const entry = await service.update(req.params.id, parsed.data);
    res.json({ entry });
  } catch (err) {
    handleError(res, err, 'Failed to update school catalog entry');
  }
}

export async function remove(req, res) {
  try {
    await service.remove(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    handleError(res, err, 'Failed to delete school catalog entry');
  }
}
