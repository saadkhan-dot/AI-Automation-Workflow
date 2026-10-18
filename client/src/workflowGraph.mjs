export const NODE_TYPES = ['input', 'transform', 'condition', 'ai', 'output'];

export function graphToWorkflow(name, nodes, edges) {
  return {
    name: name.trim(),
    nodes: nodes.map(({ id, data }) => ({ id, type: data.workflowType, config: structuredClone(data.config) })),
    edges: edges.map(edge => ({ from: edge.source, to: edge.target })),
  };
}

export function workflowToGraph(workflow, savedPositions = {}) {
  const baseX = 100;
  const gap = 210;
  const nodes = workflow.nodes.map((node, index) => ({
    id: node.id,
    type: 'workflowNode',
    position: savedPositions[node.id] || { x: baseX + index * gap, y: 140 },
    data: { workflowType: node.type, config: structuredClone(node.config) },
  }));
  const edges = workflow.edges.map((edge, index) => ({
    id: `edge-${index}-${edge.from}-${edge.to}`,
    source: edge.from,
    target: edge.to,
    type: 'smoothstep',
    animated: false,
  }));
  return { nodes, edges };
}

function hasPath(edges, start, end) {
  const adjacency = new Map();
  for (const edge of edges) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(edge.target);
  }
  const pending = [start];
  const seen = new Set();
  while (pending.length) {
    const current = pending.pop();
    if (current === end) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(adjacency.get(current) || []));
  }
  return false;
}

export function connectionIssue(connection, nodes, edges) {
  const source = nodes.find(node => node.id === connection.source);
  const target = nodes.find(node => node.id === connection.target);
  if (!source || !target) return 'Choose two existing nodes to connect.';
  if (source.id === target.id) return 'A node cannot connect to itself.';
  if (hasPath(edges, target.id, source.id)) return 'This connection would create a cycle.';
  if (source.data.workflowType === 'output') return 'Output nodes cannot have outgoing connections.';
  if (target.data.workflowType === 'input') return 'Input nodes cannot have incoming connections.';
  if (edges.some(edge => edge.target === target.id)) return 'This node already has an incoming connection.';
  if (edges.some(edge => edge.source === source.id)) return 'Branching connections are not supported.';

  const allowedSources = {
    transform: ['input', 'transform'],
    condition: ['input', 'transform'],
    ai: ['input', 'transform'],
    output: ['condition', 'ai'],
  };
  if (!allowedSources[target.data.workflowType]?.includes(source.data.workflowType)) {
    return `A ${source.data.workflowType} node cannot connect to a ${target.data.workflowType} node.`;
  }
  return null;
}

export function makeNodeConfig(type, text = '') {
  switch (type) {
    case 'input': return { text };
    case 'transform': return { trim: true, normalizeWhitespace: true };
    case 'condition': return { operator: 'nonEmpty' };
    case 'ai': return { instruction: '', responseFormat: 'text' };
    case 'output': return {};
    default: throw new Error(`Unsupported node type: ${type}`);
  }
}

export function workflowFromGraph(name, nodes, edges) {
  return graphToWorkflow(name, nodes, edges);
}
