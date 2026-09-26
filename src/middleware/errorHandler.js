/**
 * 404 and error handling. Mount both after every route.
 */

const { config } = require('../config');

function notFound() {
  return (req, res) => {
    res.status(404).json({ error: 'Not found', request_id: req.requestId });
  };
}

/**
 * Terminal error handler.
 *
 * Express identifies this by its four-argument signature, so `next` must stay in
 * the list even though it is unused.
 */
// eslint-disable-next-line no-unused-vars
function errorHandler() {
  return (err, req, res, next) => {
    const status = Number.isInteger(err.status) ? err.status : 500;

    (req.log || console).error('http.unhandled_error', {
      message: err.message,
      status,
      stack: err.stack,
    });

    // If the response has already started, the status and headers are gone;
    // handing it to Express lets it destroy the socket rather than throw.
    if (res.headersSent) return next(err);

    res.status(status).json({
      error: status >= 500 ? 'Internal server error' : err.message,
      // The request id is what turns a user's screenshot into a log search.
      request_id: req.requestId,
      // Stack traces name internal paths and packages. Useful locally, an
      // information leak in production.
      ...(config.isProduction ? {} : { detail: err.message, stack: err.stack }),
    });
  };
}

module.exports = { notFound, errorHandler };
