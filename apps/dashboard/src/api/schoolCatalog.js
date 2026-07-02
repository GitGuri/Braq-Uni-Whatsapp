import api from './client.js';

export const listSchoolCatalog = (school) =>
  api.get('/school-catalog', { params: school ? { school } : {} }).then(r => r.data.entries);

export const listSchools = () =>
  api.get('/school-catalog/schools').then(r => r.data.schools);

export const createSchoolCatalogEntry = (data) =>
  api.post('/school-catalog', data).then(r => r.data.entry);

export const updateSchoolCatalogEntry = (id, data) =>
  api.patch(`/school-catalog/${id}`, data).then(r => r.data.entry);

export const deleteSchoolCatalogEntry = (id) =>
  api.delete(`/school-catalog/${id}`).then(r => r.data);
