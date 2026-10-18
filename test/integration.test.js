const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtemp, rm } = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const mongoose = require('mongoose');
const { createApp } = require('../src/app');
const { enqueueWorkflow, claimNextExecution, failStaleExecutions, finishExecution } = require('../src/workflows/service');
const { executeClaimedExecution } = require('../src/workflows/worker');
const { executeWorkflow } = require('../src/workflows/executor');
const { executeNode } = require('../src/workflows/nodeRegistry');
const Workflow = require('../src/models/workflow');
const Execution = require('../src/models/execution');
const { exampleWorkflow } = require('../src/workflows/examples');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForMongo(uri, child) {
  const deadline = Date.now() + 10000;
  let lastError;
  while (Date.now() < deadline && child.exitCode === null) {
    try { await mongoose.connect(uri, { serverSelectionTimeoutMS: 500 }); return; }
    catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 150)); }
  }
  throw lastError || new Error('mongod exited before becoming ready');
}

test('API validates requests and persists workflows and execution records in an isolated MongoDB', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'workflow-phase1-'));
  const port = await freePort();
  const child = spawn(process.env.MONGOD_BIN || 'mongod', ['--dbpath', dir, '--port', String(port), '--bind_ip', '127.0.0.1', '--quiet'], { stdio: 'ignore' });
  const uri = `mongodb://127.0.0.1:${port}/workflow_test_isolated`;
  let httpServer;
  try {
    await waitForMongo(uri, child);
    const app = createApp();
    httpServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => httpServer.once('listening', resolve));
    const base = `http://127.0.0.1:${httpServer.address().port}`;
    const health = await fetch(`${base}/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const invalid = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'bad', nodes: [], edges: [] }) });
    assert.equal(invalid.status, 400);
    const invalidConfig = structuredClone(exampleWorkflow);
    invalidConfig.nodes[1].config.trim = 'yes';
    const invalidConfigResponse = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(invalidConfig) });
    assert.equal(invalidConfigResponse.status, 400);
    assert.doesNotMatch(await invalidConfigResponse.text(), /stack|node_modules|secret/i);

    const malformedJson = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"name":' });
    assert.equal(malformedJson.status, 400);
    assert.doesNotMatch(await malformedJson.text(), /stack|node_modules/i);

    const createdResponse = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(exampleWorkflow) });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const id = created._id;

    const fetched = await fetch(`${base}/api/workflows/${id}`);
    assert.equal(fetched.status, 200);
    const validation = await fetch(`${base}/api/workflows/${id}/validate`, { method: 'POST' });
    const validationBody = await validation.json();
    assert.equal(validation.status, 200, JSON.stringify(validationBody));
    assert.deepEqual(validationBody.executionOrder, ['input', 'normalize', 'check', 'output']);
    const run = await fetch(`${base}/api/workflows/${id}/run`, { method: 'POST' });
    assert.equal(run.status, 202);
    const runBody = await run.json();
    assert.equal(runBody.status, 'queued');

    const queuedDetails = await fetch(`${base}/api/executions/${runBody.executionId}`);
    assert.equal((await queuedDetails.json()).status, 'queued');
    const claimedExample = await claimNextExecution('integration-worker');
    assert.equal(String(claimedExample._id), runBody.executionId);
    await executeClaimedExecution(claimedExample, 'integration-worker');

    const details = await fetch(`${base}/api/executions/${runBody.executionId}`);
    assert.equal(details.status, 200);
    const execution = await details.json();
    assert.equal(execution.status, 'succeeded');
    assert.equal(execution.nodeResults.length, 4);
    assert.deepEqual(execution.nodeResults.map(node => node.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
    assert.deepEqual(execution.result, { passed: true, text: 'Hello workflow' });
    assert.equal('workerId' in execution, false);
    assert.equal('heartbeatAt' in execution, false);
    assert.equal(await finishExecution(runBody.executionId, 'integration-worker', { status: 'succeeded' }), false);
    assert.ok(await Workflow.findById(id));
    assert.ok(await Execution.findById(runBody.executionId));

    const missing = await fetch(`${base}/api/workflows/000000000000000000000000`);
    assert.equal(missing.status, 404);
    const missingExecution = await fetch(`${base}/api/executions/000000000000000000000000`);
    assert.equal(missingExecution.status, 404);
    const invalidWorkflowId = await fetch(`${base}/api/workflows/not-an-object-id`);
    assert.equal(invalidWorkflowId.status, 400);
    const invalidExecutionId = await fetch(`${base}/api/executions/not-an-object-id`);
    assert.equal(invalidExecutionId.status, 400);

    const failingQueueServer = createApp({ enqueueExecution: async () => { throw new Error('private database credential'); } }).listen(0, '127.0.0.1');
    await new Promise(resolve => failingQueueServer.once('listening', resolve));
    const unavailableQueueResponse = await fetch(`http://127.0.0.1:${failingQueueServer.address().port}/api/workflows/${id}/run`, { method: 'POST' });
    assert.equal(unavailableQueueResponse.status, 500);
    assert.deepEqual(await unavailableQueueResponse.json(), { error: 'Internal server error' });
    assert.equal(await Execution.countDocuments({ status: 'queued' }), 0);
    await new Promise(resolve => failingQueueServer.close(resolve));

    const failingDefinition = structuredClone(exampleWorkflow);
    failingDefinition.name = 'Persist injected runtime failure';
    const storedFailingWorkflow = await Workflow.create(failingDefinition);
    const pendingFailure = await enqueueWorkflow(storedFailingWorkflow.toObject());
    const claimedFailure = await claimNextExecution('integration-worker');
    await executeClaimedExecution(claimedFailure, 'integration-worker', {
      executeWorkflow: (workflow, options) => executeWorkflow(workflow, { ...options, executeNode: async (type, context) => {
        if (type === 'transform') throw new Error('private runtime detail');
        return executeNode(type, context);
      } }),
    });
    const persistedFailure = await Execution.findById(pendingFailure._id).lean();
    assert.equal(persistedFailure.status, 'failed');
    assert.equal(persistedFailure.nodeResults[1].error, 'Node execution failed');
    assert.deepEqual(persistedFailure.nodeResults.slice(2).map(node => node.status), ['skipped', 'skipped']);

    const aiDefinition = {
      name: 'Persist mocked AI execution',
      nodes: [
        { id: 'input', type: 'input', config: { text: 'private prompt input' } },
        { id: 'ai', type: 'ai', config: { instruction: 'classify sentiment', responseFormat: 'text' } },
        { id: 'output', type: 'output', config: {} },
      ],
      edges: [{ from: 'input', to: 'ai' }, { from: 'ai', to: 'output' }],
    };
    const aiWorkflowResponse = await fetch(`${base}/api/workflows`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(aiDefinition) });
    assert.equal(aiWorkflowResponse.status, 201);
    const savedAiWorkflow = await aiWorkflowResponse.json();
    const loadedAiWorkflowResponse = await fetch(`${base}/api/workflows/${savedAiWorkflow._id}`);
    assert.equal(loadedAiWorkflowResponse.status, 200);
    const loadedAiWorkflow = await loadedAiWorkflowResponse.json();
    assert.deepEqual(loadedAiWorkflow.nodes[1].config, { instruction: 'classify sentiment', responseFormat: 'text' });
    const pendingAiSuccess = await enqueueWorkflow(savedAiWorkflow);
    const claimedAiSuccess = await claimNextExecution('integration-worker');
    await executeClaimedExecution(claimedAiSuccess, 'integration-worker', {
      executeWorkflow: (workflow, options) => executeWorkflow(workflow, { ...options, executeNode: async (type, context) => type === 'ai'
        ? { response: 'positive', model: 'mock-model', latencyMs: 9 }
        : executeNode(type, context) }),
    });
    const persistedAiSuccess = await Execution.findById(pendingAiSuccess._id).lean();
    assert.equal(persistedAiSuccess.status, 'succeeded');
    assert.equal(persistedAiSuccess.nodeResults[1].output.response, 'positive');
    assert.ok(persistedAiSuccess.nodeResults[1].elapsedMs >= 0);
    assert.equal('input' in persistedAiSuccess.nodeResults[1], false);
    const pendingAiFailure = await enqueueWorkflow(savedAiWorkflow);
    const claimedAiFailure = await claimNextExecution('integration-worker');
    await executeClaimedExecution(claimedAiFailure, 'integration-worker', {
      executeWorkflow: (workflow, options) => executeWorkflow(workflow, { ...options, executeNode: async (type, context) => {
        if (type === 'ai') { const error = new Error('Ollama timed out'); error.category = 'timeout'; throw error; }
        return executeNode(type, context);
      } }),
    });
    const persistedAiFailure = await Execution.findById(pendingAiFailure._id).lean();
    assert.equal(persistedAiFailure.status, 'failed');
    assert.equal(persistedAiFailure.nodeResults[1].errorCategory, 'timeout');
    assert.equal(persistedAiFailure.nodeResults[2].status, 'skipped');
    assert.doesNotMatch(JSON.stringify(persistedAiFailure.nodeResults[1]), /private prompt input/);

    const firstQueued = await enqueueWorkflow(created);
    const claims = await Promise.all([claimNextExecution('claim-worker-a'), claimNextExecution('claim-worker-b')]);
    assert.equal(claims.filter(Boolean).length, 1);
    const stale = claims.find(Boolean);
    assert.equal(String(stale._id), String(firstQueued._id));
    await Execution.updateOne({ _id: stale._id }, { $set: { heartbeatAt: new Date(Date.now() - 60000), nodeResults: [{ nodeId: 'input', status: 'running' }] } });
    const recovered = await failStaleExecutions(5000);
    assert.equal(recovered.modifiedCount, 1);
    const staleRecord = await Execution.findById(stale._id).lean();
    assert.equal(staleRecord.status, 'failed');
    assert.equal(staleRecord.errorCategory, 'worker_lost');
    assert.equal(staleRecord.nodeResults[0].status, 'failed');

    const anotherClaim = await claimNextExecution('claim-worker-c');
    assert.equal(anotherClaim, null);
    t.diagnostic('MongoDB integration test used an isolated temporary dbpath and workflow_test_isolated database');
  } finally {
    if (httpServer) await new Promise(resolve => httpServer.close(resolve));
    await mongoose.disconnect();
    child.kill('SIGTERM');
    await new Promise(resolve => child.once('exit', resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
