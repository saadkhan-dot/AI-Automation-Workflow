const crypto = require('node:crypto');
const mongoose = require('mongoose');
const Workflow = require('../models/workflow');
const { executeWorkflow } = require('./executor');
const {
  claimNextExecution,
  updateExecutionProgress,
  finishExecution,
  failClaimedExecution,
  heartbeatWorker,
  failStaleExecutions,
} = require('./service');
const { mongoUri } = require('../config');

function workerSettings(env = process.env) {
  const concurrency = Number(env.WORKER_CONCURRENCY || 2);
  const pollIntervalMs = Number(env.WORKER_POLL_INTERVAL_MS || 500);
  const leaseTimeoutMs = Number(env.WORKER_LEASE_TIMEOUT_MS || 60000);
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error('WORKER_CONCURRENCY must be an integer from 1 to 32');
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 60000) throw new Error('WORKER_POLL_INTERVAL_MS must be an integer from 100 to 60000');
  if (!Number.isSafeInteger(leaseTimeoutMs) || leaseTimeoutMs < 5000 || leaseTimeoutMs > 600000) throw new Error('WORKER_LEASE_TIMEOUT_MS must be an integer from 5000 to 600000');
  return { concurrency, pollIntervalMs, leaseTimeoutMs };
}

async function executeClaimedExecution(execution, workerId, options = {}) {
  const execute = options.executeWorkflow || executeWorkflow;
  let lastPersistedNodeResults = [];
  try {
    const workflow = await Workflow.findById(execution.workflowId).lean();
    if (!workflow) {
      await failClaimedExecution(execution._id, workerId, 'Workflow definition is no longer available.', 'workflow_missing', []);
      return;
    }
    const outcome = await execute(workflow, {
      onProgress: async nodeResults => {
        const updated = await updateExecutionProgress(execution._id, workerId, nodeResults);
        if (!updated) throw new Error('Execution lease is no longer active');
        lastPersistedNodeResults = structuredClone(nodeResults);
      },
    });
    await finishExecution(execution._id, workerId, outcome);
  } catch {
    const finishedAt = new Date();
    const nodeResults = lastPersistedNodeResults.map(node => node.status === 'running'
      ? { ...node, status: 'failed', error: 'Worker could not complete this execution.', errorCategory: 'worker_error', finishedAt }
      : node);
    await failClaimedExecution(execution._id, workerId, 'Worker could not complete this execution.', 'worker_error', nodeResults);
  }
}

function startWorker(options = {}) {
  const settings = { ...workerSettings(), ...options };
  const workerId = settings.workerId || `${process.pid}-${crypto.randomUUID()}`;
  const executeWorkflowImpl = settings.executeWorkflow || executeWorkflow;
  let active = 0;
  let stopped = false;
  let polling = false;
  let pollTimer;
  let heartbeatTimer;

  const runClaimed = execution => executeClaimedExecution(execution, workerId, { executeWorkflow: executeWorkflowImpl })
    .catch(() => {})
    .finally(() => { active -= 1; });

  const poll = async () => {
    if (stopped || polling) return;
    polling = true;
    try {
      await failStaleExecutions(settings.leaseTimeoutMs);
      while (!stopped && active < settings.concurrency) {
        const execution = await claimNextExecution(workerId);
        if (!execution) break;
        active += 1;
        void runClaimed(execution);
      }
    } catch {
      // MongoDB is the queue. A temporary connection failure is retried on the next poll.
    } finally {
      polling = false;
      if (!stopped) pollTimer = setTimeout(poll, settings.pollIntervalMs);
    }
  };

  heartbeatTimer = setInterval(() => {
    heartbeatWorker(workerId).catch(() => {});
  }, Math.max(1000, Math.floor(settings.leaseTimeoutMs / 3)));
  void poll();

  return {
    workerId,
    async stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearInterval(heartbeatTimer);
      while (active > 0) await new Promise(resolve => setTimeout(resolve, 10));
    },
    get activeCount() { return active; },
  };
}

async function start() {
  const settings = workerSettings();
  await mongoose.connect(mongoUri);
  const worker = startWorker(settings);
  console.log(`Workflow worker ${worker.workerId} started (concurrency ${settings.concurrency})`);
  const shutdown = async () => {
    await worker.stop();
    await mongoose.disconnect();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch(error => { console.error('Unable to start workflow worker:', error.message); process.exit(1); });
}

module.exports = { workerSettings, executeClaimedExecution, startWorker, start };
