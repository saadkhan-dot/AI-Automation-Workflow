const Workflow = require('../models/workflow');
const Execution = require('../models/execution');
const { validateWorkflow } = require('./validator');

async function createWorkflow(definition) {
  validateWorkflow(definition);
  return Workflow.create(definition);
}

async function enqueueWorkflow(workflow) {
  validateWorkflow(workflow);
  return Execution.create({ workflowId: workflow._id, status: 'queued', nodeResults: [] });
}

async function claimNextExecution(workerId, now = new Date()) {
  return Execution.findOneAndUpdate(
    { status: 'queued' },
    { $set: { status: 'running', startedAt: now, heartbeatAt: now, workerId } },
    { new: true, sort: { createdAt: 1 } },
  ).select('+workerId +heartbeatAt');
}

async function updateExecutionProgress(executionId, workerId, nodeResults, heartbeatAt = new Date()) {
  const updated = await Execution.updateOne(
    { _id: executionId, status: 'running', workerId },
    { $set: { nodeResults, heartbeatAt } },
  );
  return updated.matchedCount === 1;
}

async function finishExecution(executionId, workerId, outcome) {
  const status = outcome.status === 'succeeded' ? 'succeeded' : 'failed';
  const updated = await Execution.updateOne(
    { _id: executionId, status: 'running', workerId },
    { $set: {
      status,
      nodeResults: outcome.nodeResults || [],
      ...(outcome.result === undefined ? {} : { result: outcome.result }),
      ...(status === 'failed' ? { error: outcome.error || 'Workflow execution failed', errorCategory: outcome.errorCategory || 'execution_error' } : {}),
      finishedAt: outcome.finishedAt || new Date(),
    }, $unset: { workerId: 1, heartbeatAt: 1 } },
  );
  return updated.matchedCount === 1;
}

async function failClaimedExecution(executionId, workerId, message, category, nodeResults) {
  return finishExecution(executionId, workerId, {
    status: 'failed',
    error: message,
    errorCategory: category,
    ...(nodeResults === undefined ? {} : { nodeResults }),
    finishedAt: new Date(),
  });
}

async function heartbeatWorker(workerId, now = new Date()) {
  return Execution.updateMany({ status: 'running', workerId }, { $set: { heartbeatAt: now } });
}

async function failStaleExecutions(leaseTimeoutMs, now = new Date()) {
  const cutoff = new Date(now.getTime() - leaseTimeoutMs);
  return Execution.updateMany(
    { status: 'running', heartbeatAt: { $lt: cutoff } },
    { $set: {
      status: 'failed',
      error: 'Worker lease expired; execution stopped without retry.',
      errorCategory: 'worker_lost',
      finishedAt: now,
      'nodeResults.$[active].status': 'failed',
      'nodeResults.$[active].error': 'Worker lease expired; execution stopped without retry.',
      'nodeResults.$[active].errorCategory': 'worker_lost',
      'nodeResults.$[active].finishedAt': now,
    }, $unset: { workerId: 1, heartbeatAt: 1 } },
    { arrayFilters: [{ 'active.status': 'running' }] },
  );
}

async function getExecutionForWorker(executionId) {
  return Execution.findById(executionId).select('+workerId +heartbeatAt');
}

module.exports = {
  createWorkflow,
  enqueueWorkflow,
  claimNextExecution,
  updateExecutionProgress,
  finishExecution,
  failClaimedExecution,
  heartbeatWorker,
  failStaleExecutions,
  getExecutionForWorker,
};
