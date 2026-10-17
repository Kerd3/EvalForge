import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createDatasetsRouter } from './routes/datasets.routes.js';
import { createEvaluationsRouter } from './routes/evaluations.routes.js';
import { createEvaluationCampaignsRouter } from './routes/evaluation-campaigns.routes.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { createAuthenticationMiddleware, requireAuthentication, sameOriginMutationGuard } from './middleware/authentication.js';
import { authService as defaultAuthService } from './services/auth.service.js';
import { createAuthRouter } from './routes/auth.routes.js';

const here = dirname(fileURLToPath(import.meta.url));

export function createApp({ datasetService, evaluationService, campaignService, authService = defaultAuthService, authMiddleware, healthCheck = async () => ({ status: 'ok' }), trustProxyHops = 0 }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', trustProxyHops);
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"]
      }
    }
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { message: 'Too many requests. Try again later.' } }
  }));

  const authenticate = authMiddleware ?? createAuthenticationMiddleware(authService);
  app.use('/api', sameOriginMutationGuard);

  app.get('/api/health', async (req, res, next) => {
    try {
      const health = await healthCheck();
      res.status(health.status === 'ok' ? 200 : 503).json({ data: health });
    } catch (error) { next(error); }
  });
  app.use('/api/auth', createAuthRouter({ authService, authenticationMiddleware: authenticate }));
  app.use('/api/datasets', authenticate, requireAuthentication, createDatasetsRouter({ datasetService }));
  app.use('/api/evaluations', authenticate, requireAuthentication, createEvaluationsRouter({ evaluationService }));
  if (campaignService) app.use('/api/evaluation-campaigns', authenticate, requireAuthentication, createEvaluationCampaignsRouter({ campaignService }));
  app.use(express.static(resolve(here, '../public')));
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
