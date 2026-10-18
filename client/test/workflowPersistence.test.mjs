import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAST_WORKFLOW_ID_KEY,
  canApplyRestoredWorkflow,
  fetchAndRememberWorkflow,
  readRememberedWorkflowId,
  readWorkflowPositions,
  rememberWorkflowId,
  restoreRememberedWorkflow,
  saveWorkflowPositions,
  workflowPositionsKey,
} from '../src/workflowPersistence.mjs';
import { workflowToGraph } from '../src/workflowGraph.mjs';

function memoryStorage() {
  const data = new Map();
  return {
    getItem: key => data.has(key) ? data.get(key) : null,
    setItem: (key, value) => data.set(key, String(value)),
    removeItem: key => data.delete(key),
  };
}

test('save remembers the returned workflow ID and manual loading replaces it', async () => {
  const storage = memoryStorage();
  assert.equal(rememberWorkflowId('workflow-a', storage), true);
  assert.equal(readRememberedWorkflowId(storage), 'workflow-a');
  await fetchAndRememberWorkflow('some-entered-id', {
    storage,
    fetchWorkflow: async id => ({ _id: 'workflow-b', requested: id }),
  });
  assert.equal(storage.getItem(LAST_WORKFLOW_ID_KEY), 'workflow-b');
});

test('startup restoration loads the remembered workflow and preserves unsaved edits', async () => {
  const storage = memoryStorage();
  rememberWorkflowId('workflow-a', storage);
  const loaded = [];
  const response = {
    _id: 'workflow-a',
    name: 'Saved',
    nodes: [
      { id: 'input-1', type: 'input', config: { text: 'saved text' } },
      { id: 'ai-1', type: 'ai', config: { instruction: 'classify sentiment', responseFormat: 'json' } },
      { id: 'output-1', type: 'output', config: {} },
    ],
    edges: [{ from: 'input-1', to: 'ai-1' }, { from: 'ai-1', to: 'output-1' }],
  };
  saveWorkflowPositions('workflow-a', { 'input-1': { x: 27, y: 64 }, 'ai-1': { x: 260, y: 64 } }, storage);
  const restored = await restoreRememberedWorkflow({
    storage,
    fetchWorkflow: async id => { assert.equal(id, 'workflow-a'); return response; },
    hasUnsavedChanges: () => false,
    onRestore: workflow => loaded.push(workflowToGraph(workflow, readWorkflowPositions(workflow._id, storage))),
  });
  assert.equal(restored.status, 'restored');
  assert.equal(loaded[0].nodes[0].data.config.text, 'saved text');
  assert.deepEqual(loaded[0].nodes[1].data.config, { instruction: 'classify sentiment', responseFormat: 'json' });
  assert.deepEqual(loaded[0].nodes[1].position, { x: 260, y: 64 });
  assert.deepEqual(loaded[0].nodes[0].position, { x: 27, y: 64 });
  assert.deepEqual(loaded[0].edges.map(edge => ({ source: edge.source, target: edge.target })), [{ source: 'input-1', target: 'ai-1' }, { source: 'ai-1', target: 'output-1' }]);

  const preserved = await restoreRememberedWorkflow({
    storage,
    fetchWorkflow: async () => response,
    hasUnsavedChanges: () => true,
    onRestore: () => assert.fail('must not overwrite unsaved edits'),
  });
  assert.equal(preserved.status, 'preserved');
  assert.equal(canApplyRestoredWorkflow(false), true);
  assert.equal(canApplyRestoredWorkflow(true), false);
});

test('deleted workflow IDs are cleared, while transient API failures remain retryable', async () => {
  const storage = memoryStorage();
  for (const [id, status] of [['deleted-id', 404], ['malformed-id', 400]]) {
    rememberWorkflowId(id, storage);
    const missing = await restoreRememberedWorkflow({
      storage,
      fetchWorkflow: async () => { throw Object.assign(new Error('Workflow not found or ID invalid'), { status }); },
      onRestore: () => assert.fail('missing workflow must not load'),
    });
    assert.equal(missing.status, 'missing');
    assert.equal(readRememberedWorkflowId(storage), '');
  }

  rememberWorkflowId('temporarily-unavailable', storage);
  const unavailable = await restoreRememberedWorkflow({
    storage,
    fetchWorkflow: async () => { throw new Error('Network unavailable'); },
    onRestore: () => assert.fail('unavailable workflow must not load'),
  });
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(readRememberedWorkflowId(storage), 'temporarily-unavailable');
});

test('canvas positions stay namespaced to the workflow ID', () => {
  const storage = memoryStorage();
  const a = { input: { x: 100, y: 80 } };
  const b = { input: { x: 400, y: 180 } };
  assert.equal(saveWorkflowPositions('workflow-a', a, storage), true);
  assert.equal(saveWorkflowPositions('workflow-b', b, storage), true);
  assert.deepEqual(readWorkflowPositions('workflow-a', storage), a);
  assert.deepEqual(readWorkflowPositions('workflow-b', storage), b);
  assert.notEqual(workflowPositionsKey('workflow-a'), workflowPositionsKey('workflow-b'));
});
