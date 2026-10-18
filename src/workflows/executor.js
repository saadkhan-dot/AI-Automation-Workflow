const { validateWorkflow } = require('./validator');
const { executeNode: runRegisteredNode } = require('./nodeRegistry');

async function executeWorkflow(workflow, options = {}) {
  const { order, nodesById } = validateWorkflow(workflow);
  const executeNode = options.executeNode || runRegisteredNode;
  const incoming = new Map([...nodesById.keys()].map(id => [id, []]));
  for (const edge of workflow.edges) incoming.get(edge.to).push(edge.from);
  const outputs = new Map();
  const nodeResults = [];
  const startedAt = new Date();
  let result;
  const reportProgress = options.onProgress || (async () => {});

  for (let index = 0; index < order.length; index += 1) {
    const id = order[index];
    const node = nodesById.get(id);
    const input = incoming.get(id).map(parent => outputs.get(parent));
    const nodeStartedAt = new Date();
    const safeInput = node.type === 'ai' ? undefined : input;
    nodeResults.push({ nodeId: id, status: 'running', ...(safeInput ? { input: safeInput } : {}), startedAt: nodeStartedAt });
    await reportProgress(nodeResults);
    try {
      const output = await executeNode(node.type, { config: node.config, inputs: input });
      outputs.set(id, output);
      const nodeFinishedAt = new Date();
      nodeResults[nodeResults.length - 1] = { nodeId: id, status: 'succeeded', ...(safeInput ? { input: safeInput } : {}), output, startedAt: nodeStartedAt, finishedAt: nodeFinishedAt, elapsedMs: Math.max(0, nodeFinishedAt - nodeStartedAt) };
      await reportProgress(nodeResults);
      if (node.type === 'output') result = output;
    } catch (error) {
      const nodeFinishedAt = new Date();
      const isKnownNodeError = error?.name === 'NodeExecutionError';
      const message = (error?.category || isKnownNodeError) ? error.message : 'Node execution failed';
      const category = error?.category || 'node_error';
      nodeResults[nodeResults.length - 1] = { nodeId: id, status: 'failed', ...(safeInput ? { input: safeInput } : {}), error: message, errorCategory: category, startedAt: nodeStartedAt, finishedAt: nodeFinishedAt, elapsedMs: Math.max(0, nodeFinishedAt - nodeStartedAt) };
      for (const skippedId of order.slice(index + 1)) nodeResults.push({ nodeId: skippedId, status: 'skipped', error: 'Skipped because an upstream node failed', startedAt: new Date(), finishedAt: new Date() });
      await reportProgress(nodeResults);
      return { status: 'failed', nodeResults, result: undefined, error: `Workflow node failed: ${message}`, errorCategory: category, startedAt, finishedAt: new Date() };
    }
  }

  return { status: 'succeeded', nodeResults, result, startedAt, finishedAt: new Date() };
}

module.exports = { executeWorkflow };
