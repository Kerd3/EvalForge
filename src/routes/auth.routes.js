import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { HttpError } from '../middleware/error-handler.js';
import { readCookie } from '../middleware/authentication.js';
import { SESSION_TTL_SECONDS } from '../services/auth.service.js';

const credentialsSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(128)
}).strict();
const registrationSchema = credentialsSchema.extend({
  password: z.string().min(12).max(128),
  bootstrap_secret: z.string().max(256).optional()
});

function setSessionCookie(res, token, expiresAt) {
  const secure = process.env.AUTH_COOKIE_SECURE === undefined
    ? process.env.NODE_ENV === 'production'
    : process.env.AUTH_COOKIE_SECURE.trim().toLowerCase() === 'true';
  const maxAge = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  const attributes = [
    `evalforge_session=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.min(SESSION_TTL_SECONDS, maxAge)}`
  ];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function clearSessionCookie(res) {
  const secure = process.env.AUTH_COOKIE_SECURE === undefined
    ? process.env.NODE_ENV === 'production'
    : process.env.AUTH_COOKIE_SECURE.trim().toLowerCase() === 'true';
  const attributes = ['evalforge_session=', 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (secure) attributes.push('Secure');
  res.setHeader('Set-Cookie', attributes.join('; '));
}

function routeError(next, error) {
  if (error instanceof HttpError) return next(error);
  return next(error);
}

export function createAuthRouter({ authService, authenticationMiddleware }) {
  const router = Router();
  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { message: 'Too many authentication attempts. Try again later.' } }
  });

  router.get('/me', authenticationMiddleware, async (req, res) => {
    res.json({ data: { authenticated: Boolean(req.user?.id), user: req.user ?? null, registration_enabled: await authService.registrationIsEnabled(), bootstrap_required: await authService.bootstrapRequired() } });
  });

  router.post('/register', loginLimiter, async (req, res, next) => {
    try {
      const parsed = registrationSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid registration payload. Use a valid email and a password of at least 12 characters.', parsed.error.issues);
      const result = await authService.register(parsed.data);
      setSessionCookie(res, result.sessionToken, result.expiresAt);
      res.status(201).json({ data: { user: result.user } });
    } catch (error) { routeError(next, error); }
  });

  router.post('/login', loginLimiter, async (req, res, next) => {
    try {
      const parsed = credentialsSchema.safeParse(req.body);
      if (!parsed.success) throw new HttpError(400, 'Invalid login payload.', parsed.error.issues);
      const result = await authService.login(parsed.data);
      setSessionCookie(res, result.sessionToken, result.expiresAt);
      res.json({ data: { user: result.user } });
    } catch (error) { routeError(next, error); }
  });

  router.post('/logout', authenticationMiddleware, async (req, res, next) => {
    try {
      const token = req.sessionToken ?? readCookie(req);
      await authService.logout(token);
      clearSessionCookie(res);
      res.json({ data: { logged_out: true } });
    } catch (error) { next(error); }
  });

  return router;
}
