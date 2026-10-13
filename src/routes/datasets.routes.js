import { Router } from 'express';
import { z } from 'zod';
import { createDatasetSchema } from '../validators/dataset.schema.js';
import { HttpError } from '../middleware/error-handler.js';

export function createDatasetsRouter({ datasetService }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ data: await datasetService.list() });
    } catch (error) { next(error); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createDatasetSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid dataset payload', parsed.error.issues);
      const dataset = await datasetService.create(parsed.data);
      res.status(201).json({ data: dataset });
    } catch (error) { next(error); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Dataset id must be a valid UUID');
      res.json({ data: await datasetService.getById(req.params.id) });
    } catch (error) { next(error); }
  });

  return router;
}
