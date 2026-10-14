import { Router } from 'express';
import { z } from 'zod';
import { createEvaluationCampaignSchema } from '../validators/evaluation.schema.js';
import { HttpError } from '../middleware/error-handler.js';

export function createEvaluationCampaignsRouter({ campaignService }) {
  const router = Router();

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createEvaluationCampaignSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid evaluation campaign payload', parsed.error.issues);
      const campaign = await campaignService.create(parsed.data);
      res.status(202).json({ data: campaign });
    } catch (error) { next(error); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Campaign id must be a valid UUID');
      res.json({ data: await campaignService.getById(req.params.id) });
    } catch (error) { next(error); }
  });

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Campaign id must be a valid UUID');
      res.json({ data: await campaignService.cancel(req.params.id) });
    } catch (error) { next(error); }
  });

  return router;
}
