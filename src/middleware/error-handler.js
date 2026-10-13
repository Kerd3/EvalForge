export class HttpError extends Error {
  constructor(statusCode, message, details) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
  }
}

export function notFoundHandler(req, res) {
  res.status(404).json({ error: { message: `Route not found: ${req.method} ${req.path}` } });
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;
  if (statusCode >= 500) {
    console.error(JSON.stringify({ level: 'error', message: error.message, path: req.path, method: req.method }));
  }
  res.status(statusCode).json({
    error: {
      message: statusCode >= 500 && process.env.NODE_ENV === 'production' ? 'Internal server error' : error.message,
      ...(error.details ? { details: error.details } : {})
    }
  });
}
