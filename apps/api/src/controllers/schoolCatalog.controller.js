import * as service from '../services/schoolCatalog.service.js';
import { HttpError } from '../utils/httpError.js';
import { logger } from '../utils/logger.js';

function handleError(res, err, fallback) {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  logger.error(fallback, { error: err.message });
  return res.status(500).json({ error: fallback });
}

export async function list(req, res) {
  try {
    const entries = await service.listAll({ school: req.query.school });
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
  const { schoolName, uniformType, description, sizes, price, currency, sortOrder } = req.body;
  if (!schoolName || !uniformType || price == null) {
    return res.status(400).json({ error: 'schoolName, uniformType and price are required' });
  }
  try {
    const entry = await service.create({ schoolName, uniformType, description, sizes, price, currency, sortOrder });
    res.status(201).json({ entry });
  } catch (err) {
    handleError(res, err, 'Failed to create school catalog entry');
  }
}

export async function update(req, res) {
  try {
    const entry = await service.update(req.params.id, req.body);
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
