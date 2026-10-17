import { Router } from 'express';
import { z } from 'zod';
import { createEvaluationSchema, compareSchema, createRecordedEvaluationSchema } from '../validators/evaluation.schema.js';
import { HttpError } from '../middleware/error-handler.js';

const runCursorSchema = z.object({ createdAt: z.string().datetime({ offset: true }), id: z.string().uuid() }).strict();

function decodeRunCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 512 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new HttpError(400, 'cursor must be a valid evaluation cursor');
  }
  let decoded;
  try { decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }
  catch { throw new HttpError(400, 'cursor must be a valid evaluation cursor'); }
  const parsed = runCursorSchema.safeParse(decoded);
  if (!parsed.success) throw new HttpError(400, 'cursor must be a valid evaluation cursor');
  return { createdAt: parsed.data.createdAt, id: parsed.data.id };
}

export function createEvaluationsRouter({ evaluationService }) {
  const router = Router();

  router.get('/', async (req, res, next) => {
    try {
      const rawLimit = req.query.limit === undefined ? 50 : Number(req.query.limit);
      if (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 100) {
        throw new HttpError(400, 'limit must be an integer between 1 and 100');
      }
      const cursor = decodeRunCursor(req.query.cursor);
      const page = await evaluationService.list(rawLimit, req.user.id, cursor);
      res.json({
        data: page.items,
        pagination: {
          has_more: page.hasMore,
          next_cursor: page.nextCursor ? Buffer.from(JSON.stringify(page.nextCursor)).toString('base64url') : null
        }
      });
    } catch (error) { next(error); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = createEvaluationSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid evaluation payload', parsed.error.issues);
      const run = await evaluationService.create(parsed.data, req.user.id);
      res.status(202).json({ data: run });
    } catch (error) { next(error); }
  });

  router.post('/recorded', async (req, res, next) => {
    try {
      const parsed = createRecordedEvaluationSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid recorded evaluation payload', parsed.error.issues);
      const run = await evaluationService.createRecorded(parsed.data, req.user.id);
      res.status(201).json({ data: run });
    } catch (error) { next(error); }
  });

  router.post('/compare', async (req, res, next) => {
    try {
      const parsed = compareSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid comparison payload', parsed.error.issues);
      res.json({ data: await evaluationService.compare(parsed.data.baseline_run_id, parsed.data.candidate_run_id, req.user.id) });
    } catch (error) { next(error); }
  });

  router.get('/:id', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Evaluation id must be a valid UUID');
      res.json({ data: await evaluationService.getById(req.params.id, req.user.id) });
    } catch (error) { next(error); }
  });

  router.post('/:id/cancel', async (req, res, next) => {
    try {
      if (!z.string().uuid().safeParse(req.params.id).success) throw new HttpError(400, 'Evaluation id must be a valid UUID');
      res.json({ data: await evaluationService.cancel(req.params.id, req.user.id) });
    } catch (error) { next(error); }
  });

  return router;
}
