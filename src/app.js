import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDatasetsRouter } from './routes/datasets.routes.js';
import { createEvaluationsRouter } from './routes/evaluations.routes.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp({ datasetService, evaluationService, healthCheck = async () => ({ status: 'ok' }) }) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { message: 'Too many requests. Try again later.' } }
  }));

  app.get('/api/health', async (req, res, next) => {
    try {
      const health = await healthCheck();
      res.status(health.status === 'ok' ? 200 : 503).json({ data: health });
    } catch (error) { next(error); }
  });
  app.use('/api/datasets', createDatasetsRouter({ datasetService }));
  app.use('/api/evaluations', createEvaluationsRouter({ evaluationService }));
  app.use(express.static(resolve(here, '../public')));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
