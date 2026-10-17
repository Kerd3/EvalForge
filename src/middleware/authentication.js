import { HttpError } from './error-handler.js';
import { authService } from '../services/auth.service.js';

export function readCookie(req, name = 'evalforge_session') {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(index + 1).trim()); }
    catch { return null; }
  }
  return null;
}

export function createAuthenticationMiddleware(service = authService) {
  return async function authenticateSession(req, res, next) {
    try {
      const token = readCookie(req);
      req.user = token ? await service.getSessionUser(token) : null;
      req.sessionToken = token;
      next();
    } catch (error) { next(error); }
  };
}

export function requireAuthentication(req, res, next) {
  if (!req.user?.id) return next(new HttpError(401, 'Authentication required. Please sign in.'));
  next();
}

/** Reject cross-origin browser mutations when an Origin header is supplied. */
export function sameOriginMutationGuard(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (!origin) return next(); // Non-browser clients do not automatically send Origin.
  try {
    const parsed = new URL(origin);
    const requestOrigin = `${req.protocol}://${String(req.get('host') ?? '').toLowerCase()}`;
    if (parsed.origin.toLowerCase() !== requestOrigin.toLowerCase()) {
      return next(new HttpError(403, 'Cross-origin state changes are not allowed.'));
    }
  } catch {
    return next(new HttpError(403, 'Invalid request origin.'));
  }
  next();
}
