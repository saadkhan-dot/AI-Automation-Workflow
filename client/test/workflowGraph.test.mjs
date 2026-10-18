import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionIssue, graphToWorkflow, makeNodeConfig, workflowToGraph } from '../src/workflowGraph.mjs';

const definition = {
  name: 'Normalize text',
  nodes: [
    { id: 'in', type: 'input', config: { text: ' hello ' } },
    { id: 'clean', type: 'transform', config: { trim: true, normalizeWhitespace: true } },
    { id: 'check', type: 'condition', config: { operator: 'nonEmpty' } },
    { id: 'out', type: 'output', config: {} },
  ],
  edges: [{ from: 'in', to: 'clean' }, { from: 'clean', to: 'check' }, { from: 'check', to: 'out' }],
};

test('workflow definitions map to canvas data and back without leaking positions', () => {
  const positions = { in: { x: 33, y: 82 }, clean: { x: 270, y: 91 } };
  const graph = workflowToGraph(definition, positions);
  assert.deepEqual(graph.nodes[0].position, positions.in);
  assert.deepEqual(graph.nodes[2].position, { x: 520, y: 140 });
  assert.equal(graph.edges[1].source, 'clean');
  const converted = graphToWorkflow(definition.name, graph.nodes, graph.edges);
  assert.deepEqual(converted, definition);
  assert.equal('position' in converted.nodes[0], false);
  assert.equal('type' in converted.edges[0], false);
});

test('node configurations match the backend-supported contracts', () => {
  assert.deepEqual(makeNodeConfig('input', 'start'), { text: 'start' });
  assert.deepEqual(makeNodeConfig('transform'), { trim: true, normalizeWhitespace: true });
  assert.deepEqual(makeNodeConfig('condition'), { operator: 'nonEmpty' });
  assert.deepEqual(makeNodeConfig('ai'), { instruction: '', responseFormat: 'text' });
  assert.deepEqual(makeNodeConfig('output'), {});
  assert.throws(() => makeNodeConfig('script'), /Unsupported node type/);
});

test('AI workflow round-trips and can connect from Input to Output', () => {
  const aiDefinition = {
    name: 'AI response',
    nodes: [
      { id: 'in', type: 'input', config: { text: 'hello' } },
      { id: 'ai', type: 'ai', config: { instruction: 'answer briefly', responseFormat: 'json' } },
      { id: 'out', type: 'output', config: {} },
    ],
    edges: [{ from: 'in', to: 'ai' }, { from: 'ai', to: 'out' }],
  };
  const graph = workflowToGraph(aiDefinition);
  assert.deepEqual(graphToWorkflow(aiDefinition.name, graph.nodes, graph.edges), aiDefinition);
  assert.equal(connectionIssue({ source: 'in', target: 'ai' }, graph.nodes, []), null);
  assert.equal(connectionIssue({ source: 'ai', target: 'out' }, graph.nodes, []), null);
});

test('connection checks prevent invalid node types, extra inputs, branches and cycles', () => {
  const graph = workflowToGraph(definition);
  assert.equal(connectionIssue({ source: 'in', target: 'clean' }, graph.nodes, graph.edges), 'This node already has an incoming connection.');
  assert.equal(connectionIssue({ source: 'out', target: 'in' }, graph.nodes, []), 'Output nodes cannot have outgoing connections.');
  assert.equal(connectionIssue({ source: 'in', target: 'out' }, graph.nodes, []), 'A input node cannot connect to a output node.');
  assert.equal(connectionIssue({ source: 'clean', target: 'out' }, graph.nodes, []), 'A transform node cannot connect to a output node.');
  assert.equal(connectionIssue({ source: 'clean', target: 'in' }, graph.nodes, []), 'Input nodes cannot have incoming connections.');

  const cycleGraph = workflowToGraph(definition);
  cycleGraph.edges = cycleGraph.edges.filter(edge => edge.id !== 'edge-0-in-clean');
  assert.equal(connectionIssue({ source: 'check', target: 'clean' }, cycleGraph.nodes, cycleGraph.edges), 'This connection would create a cycle.');
});
