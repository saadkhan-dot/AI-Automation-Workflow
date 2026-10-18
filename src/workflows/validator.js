const NODE_TYPES = new Set(['input', 'transform', 'condition', 'ai', 'output']);
const { validateNodeConfig, NodeExecutionError } = require('./nodeRegistry');

class WorkflowValidationError extends Error {
  constructor(errors) {
    super('Workflow definition is invalid');
    this.name = 'WorkflowValidationError';
    this.errors = errors;
  }
}

function validateWorkflow(workflow) {
  const errors = [];
  if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
    throw new WorkflowValidationError(['Workflow must be an object']);
  }
  if (typeof workflow.name !== 'string' || !workflow.name.trim()) errors.push('name must be a non-empty string');
  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) errors.push('nodes must be a non-empty array');
  if (!Array.isArray(workflow.edges)) errors.push('edges must be an array');
  if (errors.length) throw new WorkflowValidationError(errors);

  const byId = new Map();
  for (const [index, node] of workflow.nodes.entries()) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) { errors.push(`nodes[${index}] must be an object`); continue; }
    if (typeof node.id !== 'string' || !node.id.trim()) { errors.push(`nodes[${index}].id must be a non-empty string`); continue; }
    if (byId.has(node.id)) errors.push(`Duplicate node id: ${node.id}`);
    else byId.set(node.id, node);
    if (!NODE_TYPES.has(node.type)) errors.push(`Node ${node.id} has unknown type: ${String(node.type)}`);
    if (!node.config || typeof node.config !== 'object' || Array.isArray(node.config)) errors.push(`Node ${node.id} config must be an object`);
    else {
      try { validateNodeConfig(node.type, node.config); }
      catch (error) {
        if (error instanceof NodeExecutionError) errors.push(`Node ${node.id}: ${error.message}`);
        else throw error;
      }
    }
  }

  const outgoing = new Map([...byId.keys()].map(id => [id, []]));
  const incoming = new Map([...byId.keys()].map(id => [id, []]));
  const seenEdges = new Set();
  for (const [index, edge] of workflow.edges.entries()) {
    if (!edge || typeof edge !== 'object' || typeof edge.from !== 'string' || typeof edge.to !== 'string') {
      errors.push(`edges[${index}] must contain string from and to node ids`); continue;
    }
    if (!byId.has(edge.from) || !byId.has(edge.to)) { errors.push(`Edge ${edge.from} -> ${edge.to} references an unknown node`); continue; }
    if (edge.from === edge.to) { errors.push(`Self-loop is not allowed: ${edge.from}`); continue; }
    const key = `${edge.from}\0${edge.to}`;
    if (seenEdges.has(key)) { errors.push(`Duplicate edge: ${edge.from} -> ${edge.to}`); continue; }
    seenEdges.add(key);
    outgoing.get(edge.from).push(edge.to);
    incoming.get(edge.to).push(edge.from);
  }

  for (const [id, node] of byId) {
    if (node.type === 'input' && incoming.get(id).length) errors.push(`Input node ${id} cannot have incoming edges`);
    if (node.type !== 'input' && incoming.get(id).length === 0) errors.push(`Node ${id} must have an incoming edge`);
    if (node.type !== 'input' && incoming.get(id).length > 1) errors.push(`Node ${id} accepts one incoming edge in Phase 1`);
    if (node.type === 'output' && outgoing.get(id).length) errors.push(`Output node ${id} cannot have outgoing edges`);
    if (node.type !== 'output' && outgoing.get(id).length === 0) errors.push(`Node ${id} must connect to a downstream node`);
    if (node.type !== 'output' && outgoing.get(id).length > 1) errors.push(`Node ${id} may have at most one outgoing edge in Phase 1`);
    for (const parentId of incoming.get(id)) {
      const parent = byId.get(parentId);
      const allowedParents = {
        transform: ['input', 'transform'],
        condition: ['input', 'transform'],
        ai: ['input', 'transform'],
        output: ['condition', 'ai'],
      }[node.type];
      if (allowedParents && !allowedParents.includes(parent.type)) errors.push(`Invalid connection: ${parent.type} node ${parentId} cannot connect to ${node.type} node ${id}`);
    }
  }

  const inputCount = [...byId.values()].filter(node => node.type === 'input').length;
  const outputCount = [...byId.values()].filter(node => node.type === 'output').length;
  if (inputCount !== 1) errors.push('Workflow must contain exactly one input node in Phase 1');
  if (outputCount !== 1) errors.push('Workflow must contain exactly one output node in Phase 1');

  const indegree = new Map([...byId.keys()].map(id => [id, incoming.get(id).length]));
  const ready = [...byId.keys()].filter(id => indegree.get(id) === 0);
  const order = [];
  while (ready.length) {
    const id = ready.shift(); order.push(id);
    for (const next of outgoing.get(id)) {
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) ready.push(next);
    }
  }
  if (order.length !== byId.size) errors.push('Workflow graph contains a cycle');
  if (errors.length) throw new WorkflowValidationError(errors);
  return { order, nodesById: byId };
}

module.exports = { validateWorkflow, WorkflowValidationError, NODE_TYPES };
