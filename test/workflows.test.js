const test = require('node:test');
const assert = require('node:assert/strict');
const { validateWorkflow, WorkflowValidationError } = require('../src/workflows/validator');
const { executeWorkflow } = require('../src/workflows/executor');
const { executeNode } = require('../src/workflows/nodeRegistry');
const { exampleWorkflow } = require('../src/workflows/examples');
const { generateText } = require('../src/workflows/ollamaClient');

test('valid example has a deterministic topological order and passes data', async () => {
  const { order } = validateWorkflow(exampleWorkflow);
  assert.deepEqual(order, ['input', 'normalize', 'check', 'output']);
  const execution = await executeWorkflow(exampleWorkflow);
  assert.equal(execution.status, 'succeeded');
  assert.deepEqual(execution.result, { passed: true, text: 'Hello workflow' });
  assert.deepEqual(execution.nodeResults.map(node => node.status), ['succeeded', 'succeeded', 'succeeded', 'succeeded']);
});

test('empty normalized text fails the condition value but completes execution', async () => {
  const workflow = structuredClone(exampleWorkflow);
  workflow.nodes[0].config.text = ' \n\t ';
  const execution = await executeWorkflow(workflow);
  assert.equal(execution.status, 'succeeded');
  assert.deepEqual(execution.result, { passed: false, text: '' });
});

for (const [label, definition] of [
  ['null workflow', null],
  ['array workflow', []],
  ['empty object', {}],
  ['missing node list', { name: 'missing nodes', edges: [] }],
  ['malformed node', { name: 'bad node', nodes: [null], edges: [] }],
]) {
  test(`rejects ${label}`, () => {
    assert.throws(() => validateWorkflow(definition), WorkflowValidationError);
  });
}

for (const [label, mutate, expected] of [
  ['duplicate ids', w => { w.nodes[1].id = w.nodes[0].id; }, /Duplicate node id/],
  ['unknown types', w => { w.nodes[0].type = 'custom'; }, /unknown type/],
  ['unknown edge references', w => { w.edges[0].to = 'missing'; }, /unknown node/],
  ['self-loops', w => { w.edges[0].to = w.edges[0].from; }, /Self-loop/],
  ['cycles', w => { w.edges.push({ from: 'output', to: 'input' }); }, /cycle/],
  ['malformed edges', w => { w.edges[0] = { from: 'input' }; }, /string from and to/],
]) {
  test(`rejects ${label}`, () => {
    const workflow = structuredClone(exampleWorkflow);
    mutate(workflow);
    assert.throws(() => validateWorkflow(workflow), error => {
      assert.ok(error instanceof WorkflowValidationError);
      assert.match(error.errors.join('; '), expected);
      return true;
    });
  });
}

test('rejects multiple input nodes and multiple output nodes', () => {
  const multipleInputs = structuredClone(exampleWorkflow);
  multipleInputs.nodes.push({ id: 'second-input', type: 'input', config: { text: 'extra' } });
  assert.throws(() => validateWorkflow(multipleInputs), error => error.errors.some(message => /exactly one input/.test(message)));

  const multipleOutputs = structuredClone(exampleWorkflow);
  multipleOutputs.nodes.push({ id: 'second-output', type: 'output', config: {} });
  assert.throws(() => validateWorkflow(multipleOutputs), error => error.errors.some(message => /exactly one output/.test(message)));
});

test('rejects invalid node configuration and malformed runtime data', () => {
  const invalidTransform = structuredClone(exampleWorkflow);
  invalidTransform.nodes[1].config.trim = 'yes';
  assert.throws(() => validateWorkflow(invalidTransform), error => error.errors.some(message => /must be booleans/.test(message)));

  const executableLookingConfig = structuredClone(exampleWorkflow);
  executableLookingConfig.nodes[1].config.handler = 'process.exit()';
  assert.throws(() => validateWorkflow(executableLookingConfig), WorkflowValidationError);
  assert.throws(() => executeNode('custom', { config: {}, inputs: [] }), /Unsupported node type/);
  assert.throws(() => executeNode('toString', { config: {}, inputs: [] }), /Unsupported node type/);
  assert.throws(() => executeNode('input', { config: { text: 7 }, inputs: [] }), /text must be a string/);
  assert.throws(() => executeNode('transform', { config: {}, inputs: [{ text: 7 }] }), /requires upstream text/);
  assert.throws(() => executeNode('output', { config: {}, inputs: [{ passed: true, text: 'one' }, { passed: false, text: 'two' }] }), /exactly 1 input/);
  assert.throws(() => executeNode('condition', { config: {}, inputs: null }), /inputs must be an array/);
});

test('node failure marks downstream nodes skipped and never reports success', async () => {
  const execution = await executeWorkflow(exampleWorkflow, {
    executeNode: async (type, context) => {
      if (type === 'transform') throw new Error('deterministic test failure');
      return executeNode(type, context);
    },
  });
  assert.equal(execution.status, 'failed');
  assert.deepEqual(execution.nodeResults.map(node => node.status), ['succeeded', 'failed', 'skipped', 'skipped']);
  assert.match(execution.error, /Node execution failed/);
});

test('workflow validation completes before any node implementation is called', async () => {
  const invalid = structuredClone(exampleWorkflow);
  invalid.edges.push({ from: 'output', to: 'input' });
  let called = false;
  await assert.rejects(() => executeWorkflow(invalid, {
    executeNode: async () => { called = true; return {}; },
  }), WorkflowValidationError);
  assert.equal(called, false);
});

function aiWorkflow() {
  return {
    name: 'Classify text',
    nodes: [
      { id: 'input', type: 'input', config: { text: 'This is great' } },
      { id: 'ai', type: 'ai', config: { instruction: 'Classify sentiment', responseFormat: 'text' } },
      { id: 'output', type: 'output', config: {} },
    ],
    edges: [{ from: 'input', to: 'ai' }, { from: 'ai', to: 'output' }],
  };
}

test('AI workflow passes a structured response through Output and omits prompt input from history', async () => {
  const workflow = aiWorkflow();
  assert.deepEqual(validateWorkflow(workflow).order, ['input', 'ai', 'output']);
  const execution = await executeWorkflow(workflow, {
    executeNode: async (type, context) => type === 'ai'
      ? { response: 'positive', model: 'test-model', latencyMs: 12 }
      : executeNode(type, context),
  });
  assert.equal(execution.status, 'succeeded');
  assert.deepEqual(execution.result, { response: 'positive', model: 'test-model', latencyMs: 12 });
  assert.equal('input' in execution.nodeResults[1], false);
  assert.ok(execution.nodeResults[1].elapsedMs >= 0);
});

test('AI configuration rejects unknown fields and unsupported values', () => {
  for (const config of [
    { instruction: 'do this', execute: 'process.exit()' },
    { instruction: '', responseFormat: 'text' },
    { instruction: 'do this', responseFormat: 'javascript' },
  ]) {
    const workflow = aiWorkflow(); workflow.nodes[1].config = config;
    assert.throws(() => validateWorkflow(workflow), WorkflowValidationError);
  }
});

test('rejects branching from AI nodes', () => {
  const workflow = aiWorkflow();
  workflow.nodes.splice(2, 0, { id: 'second-output', type: 'output', config: {} });
  workflow.edges.push({ from: 'ai', to: 'second-output' });
  assert.throws(() => validateWorkflow(workflow), error => {
    assert.ok(error instanceof WorkflowValidationError);
    assert.match(error.errors.join('; '), /at most one outgoing edge/);
    return true;
  });
});

test('AI execution failure marks execution failed and skips Output', async () => {
  const execution = await executeWorkflow(aiWorkflow(), {
    executeNode: async (type, context) => {
      if (type === 'ai') { const error = new Error('Ollama request timed out'); error.category = 'timeout'; throw error; }
      return executeNode(type, context);
    },
  });
  assert.equal(execution.status, 'failed');
  assert.deepEqual(execution.nodeResults.map(result => result.status), ['succeeded', 'failed', 'skipped']);
  assert.equal(execution.nodeResults[1].errorCategory, 'timeout');
  assert.equal(execution.result, undefined);
});

test('Ollama client uses the local generate API and returns validated response metadata', async () => {
  let request;
  const result = await generateText({ text: 'hello', instruction: 'classify', responseFormat: 'json' }, {
    config: { baseUrl: 'http://localhost:11434', model: 'local-model', timeoutMs: 1000 },
    fetchImpl: async (url, options) => {
      request = { url, options };
      return { ok: true, json: async () => ({ response: '{"label":"positive"}', model: 'local-model' }) };
    },
  });
  assert.equal(request.url, 'http://localhost:11434/api/generate');
  const body = JSON.parse(request.options.body);
  assert.equal(body.stream, false); assert.equal(body.format, 'json');
  assert.equal(body.prompt, 'Instruction:\nclassify\n\nText:\nhello');
  assert.equal(result.response, '{"label":"positive"}');
  assert.equal(result.model, 'local-model');
  assert.ok(result.latencyMs >= 0);
});

test('Ollama failures are categorized and sanitized', async () => {
  const config = { baseUrl: 'http://localhost:11434', model: 'model', timeoutMs: 1000 };
  await assert.rejects(generateText({ text: 'x', instruction: 'y' }, { config, fetchImpl: async () => { throw new Error('secret token http://private'); } }), error => {
    assert.equal(error.category, 'unavailable'); assert.equal(error.message, 'Ollama is unavailable'); return true;
  });
  await assert.rejects(generateText({ text: 'x', instruction: 'y' }, { config, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('raw response'); } }) }), error => error.category === 'invalid_response');
  await assert.rejects(generateText({ text: 'x', instruction: 'y' }, { config, fetchImpl: async () => ({ ok: true, json: async () => ({ response: 7 }) }) }), error => error.category === 'invalid_response');
  await assert.rejects(generateText({ text: 'x', instruction: 'y', responseFormat: 'json' }, { config, fetchImpl: async () => ({ ok: true, json: async () => ({ response: 'not json' }) }) }), error => error.category === 'invalid_output');
  await assert.rejects(generateText({ text: 'x', instruction: 'y' }, { config, timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))) }), error => error.category === 'timeout');
});
