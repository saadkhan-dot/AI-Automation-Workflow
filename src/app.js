const express = require('express');
const Workflow = require('./models/workflow');
const Execution = require('./models/execution');
const { createWorkflow, enqueueWorkflow } = require('./workflows/service');
const { validateWorkflow } = require('./workflows/validator');
const { notFound, errorHandler } = require('./middleware/errors');

function createApp(options = {}) {
  const app = express();
  const enqueueExecution = options.enqueueExecution || enqueueWorkflow;
  app.use(express.json({ limit: '1mb', strict: true }));

  app.get('/health', (req, res) => res.json({ status: 'ok' }));
  app.post('/api/workflows', async (req, res, next) => {
    try {
      const workflow = await createWorkflow(req.body);
      res.status(201).json(workflow);
    } catch (error) { next(error); }
  });
  app.get('/api/workflows/:id', async (req, res, next) => {
    try {
      const workflow = await Workflow.findById(req.params.id).lean();
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
      res.json(workflow);
    } catch (error) { next(error); }
  });
  app.post('/api/workflows/:id/validate', async (req, res, next) => {
    try {
      const workflow = await Workflow.findById(req.params.id).lean();
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
      const validation = validateWorkflow(workflow);
      res.json({ valid: true, executionOrder: validation.order });
    } catch (error) { next(error); }
  });
  app.post('/api/workflows/:id/run', async (req, res, next) => {
    try {
      const workflow = await Workflow.findById(req.params.id).lean();
      if (!workflow) return res.status(404).json({ error: 'Workflow not found' });
      const execution = await enqueueExecution(workflow);
      res.status(202).json({ executionId: execution._id, status: execution.status });
    } catch (error) { next(error); }
  });
  app.get('/api/executions/:executionId', async (req, res, next) => {
    try {
      const execution = await Execution.findById(req.params.executionId).lean();
      if (!execution) return res.status(404).json({ error: 'Execution not found' });
      // Phase 3 records used "success" before the explicit asynchronous lifecycle.
      if (execution.status === 'success') execution.status = 'succeeded';
      execution.nodeResults = (execution.nodeResults || []).map(node => node.status === 'success' ? { ...node, status: 'succeeded' } : node);
      res.json(execution);
    } catch (error) { next(error); }
  });

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
