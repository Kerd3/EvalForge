import { Router } from 'express';
import { z } from 'zod';
import { createDatasetSchema } from '../validators/dataset.schema.js';
import { HttpError } from '../middleware/error-handler.js';

export function createDatasetsRouter({ datasetService }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      res.json({ data: await datasetService.list(req.user.id) });
    } catch (error) { next(error); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createDatasetSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid dataset payload', parsed.error.issues);
      const dataset = await datasetService.create(parsed.data, req.user.id);
      res.status(201).json({ data: dataset });
    } catch (error) { next(error); }
  });

  // Dataset edits are saved as a new immutable version. Existing runs keep
  // pointing at the version of the test cases they originally evaluated.
  router.put('/:id', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        throw new HttpError(400, 'Dataset id must be a valid UUID');
      }
      const parsed = createDatasetSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid dataset payload', parsed.error.issues);
      const dataset = await datasetService.createVersion(req.params.id, parsed.data, req.user.id);
      res.json({ data: dataset });
    } catch (error) { next(error); }
  });

  router.get('/:id/calibration', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        throw new HttpError(400, 'Dataset id must be a valid UUID');
      }
      if (typeof datasetService.calibrate !== 'function') {
        throw new HttpError(501, 'Golden-set calibration is not available in this service implementation');
      }
      let versionId;
      if (req.query.version_id !== undefined) {
        const parsedVersionId = z.string().uuid().safeParse(req.query.version_id);
        if (!parsedVersionId.success) throw new HttpError(400, 'version_id must be a valid UUID');
        versionId = parsedVersionId.data;
      }
      const report = versionId
        ? await datasetService.calibrate(req.params.id, req.user.id, versionId)
        : await datasetService.calibrate(req.params.id, req.user.id);
      res.json({ data: report });
    } catch (error) { next(error); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Dataset id must be a valid UUID');
      res.json({ data: await datasetService.getById(req.params.id, req.user.id) });
    } catch (error) { next(error); }
  });

  return router;
}
