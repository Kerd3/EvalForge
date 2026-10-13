import { Router } from 'express';
import { z } from 'zod';
import { createEvaluationSchema, compareSchema } from '../validators/evaluation.schema.js';
import { HttpError } from '../middleware/error-handler.js';

export function createEvaluationsRouter({ evaluationService }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
        throw new HttpError(400, 'limit must be an integer between 1 and 100');
      }
      res.json({ data: await evaluationService.list(rawLimit) });
    } catch (error) { next(error); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createEvaluationSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid evaluation payload', parsed.error.issues);
      const run = await evaluationService.create(parsed.data);
      res.status(202).json({ data: run });
    } catch (error) { next(error); }
  });

  router.post('/compare', async (req, res, next) => {
    try {
      const parsed = compareSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid comparison payload', parsed.error.issues);
      res.json({ data: await evaluationService.compare(parsed.data.baseline_run_id, parsed.data.candidate_run_id) });
    } catch (error) { next(error); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Evaluation id must be a valid UUID');
      res.json({ data: await evaluationService.getById(req.params.id) });
    } catch (error) { next(error); }
  });

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Evaluation id must be a valid UUID');
      res.json({ data: await evaluationService.cancel(req.params.id) });
    } catch (error) { next(error); }
  });

  return router;
}
