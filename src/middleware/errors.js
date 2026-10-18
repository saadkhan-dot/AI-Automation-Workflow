const { WorkflowValidationError } = require('../workflows/validator');

function notFound(req, res) { res.status(404).json({ error: 'Resource not found' }); }

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof WorkflowValidationError) return res.status(400).json({ error: error.message, details: error.errors });
  if (error.name === 'CastError' || error.name === 'BSONError') return res.status(400).json({ error: 'Invalid identifier' });
  if (error.name === 'ValidationError') return res.status(400).json({ error: 'Request validation failed' });
  if (error.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (error.status === 413) return res.status(413).json({ error: 'Request body is too large' });
  return res.status(500).json({ error: 'Internal server error' });
}

module.exports = { notFound, errorHandler };
