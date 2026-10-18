import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { addEdge, applyEdgeChanges, applyNodeChanges, Background, Controls, MiniMap, ReactFlow, ReactFlowProvider } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import WorkflowNode from './WorkflowNode.jsx';
import { startExecutionPolling } from './executionPolling.mjs';
import { connectionIssue, graphToWorkflow, makeNodeConfig, workflowToGraph } from './workflowGraph.mjs';
import { fetchAndRememberWorkflow, readRememberedWorkflowId, readWorkflowPositions, rememberWorkflowId, restoreRememberedWorkflow, saveWorkflowPositions } from './workflowPersistence.mjs';
import './styles.css';

const API_BASE = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, '');
const EMPTY_SNAPSHOT = JSON.stringify({ name: 'Untitled workflow', nodes: [], edges: [] });
const nodeTypes = { workflowNode: WorkflowNode };
const palette = [
  { type: 'input', label: 'Input', description: 'Provide text to start the workflow', symbol: '↳' },
  { type: 'transform', label: 'Transform', description: 'Trim and normalize whitespace', symbol: '⌁' },
  { type: 'condition', label: 'Condition', description: 'Check whether text is non-empty', symbol: '?' },
  { type: 'ai', label: 'AI', description: 'Generate a response with local Ollama', symbol: '✳' },
  { type: 'output', label: 'Output', description: 'Return the condition and text', symbol: '↗' },
];

async function request(path, options = {}) {
  const { allowStatus = [], ...fetchOptions } = options;
  let response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      ...fetchOptions,
      headers: { ...(fetchOptions.body ? { 'content-type': 'application/json' } : {}), ...fetchOptions.headers },
    });
  } catch {
    throw new Error('Could not reach the workflow API. Check that the backend is running.');
  }
  let body;
  try { body = await response.json(); } catch { body = {}; }
  if (!response.ok && !allowStatus.includes(response.status)) {
    const details = Array.isArray(body.details) ? ` ${body.details.join(' ')}` : '';
    const message = body.error || `Request failed (${response.status})`;
    throw Object.assign(new Error(`${message}.${details}`), { status: response.status });
  }
  return body;
}

function savePositions(id, nodes) {
  if (!id) return;
  const positions = Object.fromEntries(nodes.map(node => [node.id, node.position]));
  saveWorkflowPositions(id, positions);
}

function idFor(type, nodes) {
  const prefix = type;
  const used = new Set(nodes.map(node => node.id));
  let counter = 1;
  while (used.has(`${prefix}-${counter}`)) counter += 1;
  return `${prefix}-${counter}`;
}

function Editor() {
  const [workflowName, setWorkflowName] = useState('Untitled workflow');
  const [nodes, setNodes] = useState([]);
  const [edges, setEdges] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [savedId, setSavedId] = useState('');
  const [loadId, setLoadId] = useState('');
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState({ kind: '', message: '' });
  const [execution, setExecution] = useState(null);
  const [pollingError, setPollingError] = useState('');
  const editorTouchedRef = useRef(false);
  const isDirtyRef = useRef(false);
  const startupRestoreStartedRef = useRef(false);
  const executionIsActive = execution && ['queued', 'running'].includes(execution.status);

  const selectedNode = nodes.find(node => node.id === selectedId) || null;
  const currentDefinition = useMemo(() => graphToWorkflow(workflowName, nodes, edges), [workflowName, nodes, edges]);
  const isDirty = JSON.stringify(currentDefinition) !== snapshot;
  isDirtyRef.current = isDirty;
  const markEditorTouched = () => { editorTouchedRef.current = true; };
  const available = type => {
    if (type === 'input' || type === 'output' || type === 'condition' || type === 'ai') return !nodes.some(node => node.data.workflowType === type);
    return true;
  };

  const onNodesChange = useCallback(changes => {
    setNodes(current => applyNodeChanges(changes, current));
    if (changes.some(change => change.type === 'remove' || change.type === 'position')) markEditorTouched();
    const removed = changes.filter(change => change.type === 'remove').map(change => change.id);
    if (removed.length) {
      setEdges(current => current.filter(edge => !removed.includes(edge.source) && !removed.includes(edge.target)));
      setSelectedId(current => removed.includes(current) ? null : current);
    }
  }, []);

  const onEdgesChange = useCallback(changes => {
    setEdges(current => applyEdgeChanges(changes, current));
    if (changes.some(change => change.type === 'remove')) markEditorTouched();
  }, []);

  const addNode = type => {
    if (!available(type)) return;
    const id = idFor(type, nodes);
    markEditorTouched();
    const node = {
      id,
      type: 'workflowNode',
      position: { x: 70 + nodes.length * 42, y: 130 + (nodes.length % 2) * 36 },
      data: { workflowType: type, config: makeNodeConfig(type, type === 'input' ? 'Hello workflow' : '') },
    };
    setNodes(current => [...current, node]);
    setSelectedId(id);
    if (!executionIsActive) setExecution(null);
    setNotice({ kind: 'info', message: `${type[0].toUpperCase()}${type.slice(1)} node added. Connect it to the workflow.` });
  };

  const updateConfig = (key, value) => {
    markEditorTouched();
    setNodes(current => current.map(node => node.id === selectedId
      ? { ...node, data: { ...node.data, config: { ...node.data.config, [key]: value } } }
      : node));
    if (!executionIsActive) setExecution(null);
  };

  const onConnect = connection => {
    const issue = connectionIssue(connection, nodes, edges);
    if (issue) {
      setNotice({ kind: 'error', message: issue });
      return;
    }
    markEditorTouched();
    setEdges(current => addEdge({ ...connection, id: `edge-${connection.source}-${connection.target}`, type: 'smoothstep' }, current));
    setNotice({ kind: 'info', message: 'Connection added.' });
    if (!executionIsActive) setExecution(null);
  };

  const applyLoadedWorkflow = useCallback(workflow => {
    const graph = workflowToGraph(workflow, readWorkflowPositions(workflow._id));
    setWorkflowName(workflow.name);
    setNodes(graph.nodes); setEdges(graph.edges);
    setSelectedId(null); setSavedId(workflow._id); setLoadId(workflow._id);
    setSnapshot(JSON.stringify(graphToWorkflow(workflow.name, graph.nodes, graph.edges)));
    setExecution(null);
    editorTouchedRef.current = false;
  }, []);

  useEffect(() => {
    if (startupRestoreStartedRef.current) return;
    startupRestoreStartedRef.current = true;
    const rememberedId = readRememberedWorkflowId();
    if (!rememberedId) return;

    setLoadId(rememberedId);
    setBusy('restore');
    setNotice({ kind: '', message: '' });
    restoreRememberedWorkflow({
      fetchWorkflow: id => request(`/api/workflows/${encodeURIComponent(id)}`),
      hasUnsavedChanges: () => editorTouchedRef.current || isDirtyRef.current,
      onRestore: applyLoadedWorkflow,
    }).then(result => {
      if (result.status === 'restored') {
        setNotice({ kind: 'success', message: `Restored “${result.workflow.name}” from your last session.` });
      } else if (result.status === 'preserved') {
        setNotice({ kind: 'info', message: 'Your current edits were kept. Load the saved workflow manually if you want to replace them.' });
      } else if (result.status === 'missing') {
        setSavedId('');
        setLoadId(current => current === result.workflowId ? '' : current);
        setNotice({ kind: 'error', message: `The remembered workflow could not be found or its ID is invalid. Start a new workflow or load another ID. ${result.error.message}` });
      } else if (result.status === 'unavailable') {
        setNotice({ kind: 'error', message: `Could not restore the remembered workflow. The ID is still saved so you can retry. ${result.error.message}` });
      }
    }).catch(error => {
      setNotice({ kind: 'error', message: `Could not restore the remembered workflow. ${error.message}` });
    }).finally(() => {
      setBusy(current => current === 'restore' ? '' : current);
    });
  }, [applyLoadedWorkflow]);

  useEffect(() => {
    if (!execution?._id || !['queued', 'running'].includes(execution.status)) return undefined;
    return startExecutionPolling({
      executionId: execution._id,
      fetchStatus: id => request(`/api/executions/${encodeURIComponent(id)}`),
      onUpdate: current => {
        setExecution(previous => previous?._id === current._id ? current : previous);
        setPollingError('');
        if (current.status === 'succeeded') {
          setNotice({ kind: 'success', message: `Run completed successfully · ${current._id}` });
        } else if (current.status === 'failed') {
          setNotice({ kind: 'error', message: `Run failed. Review the node results below · ${current._id}` });
        }
      },
      onError: error => setPollingError(error.message || 'Execution status is temporarily unavailable.'),
      intervalMs: 1000,
    });
  }, [execution?._id, execution?.status]);

  const loadWorkflow = async event => {
    event.preventDefault();
    if (busy || executionIsActive) return;
    const requestedId = loadId.trim();
    if (!requestedId) return;
    if (isDirty && !window.confirm('Discard your unsaved workflow changes and load another workflow?')) return;
    setBusy('load'); setNotice({ kind: '', message: '' });
    try {
      const workflow = await fetchAndRememberWorkflow(requestedId, {
        fetchWorkflow: id => request(`/api/workflows/${encodeURIComponent(id)}`),
      });
      applyLoadedWorkflow(workflow);
      setNotice({ kind: 'success', message: `Loaded “${workflow.name}”.` });
    } catch (error) { setNotice({ kind: 'error', message: error.message }); }
    finally { setBusy(''); }
  };

  const storeSnapshot = async forceNew => {
    if (!forceNew && savedId && !isDirty) return { id: savedId, remembered: rememberWorkflowId(savedId) };
    const created = await request('/api/workflows', { method: 'POST', body: JSON.stringify(currentDefinition) });
    setSavedId(created._id);
    setLoadId(created._id);
    setSnapshot(JSON.stringify(currentDefinition));
    savePositions(created._id, nodes);
    editorTouchedRef.current = false;
    return { id: created._id, remembered: rememberWorkflowId(created._id) };
  };

  const saveWorkflow = async () => {
    setBusy('save'); setNotice({ kind: '', message: '' });
    try {
      const stored = await storeSnapshot(true);
      setNotice({ kind: 'success', message: `Saved workflow snapshot. ID: ${stored.id}${stored.remembered ? '' : ' (browser could not remember this ID).'}` });
    } catch (error) { setNotice({ kind: 'error', message: error.message }); }
    finally { setBusy(''); }
  };

  const validateWorkflow = async () => {
    setBusy('validate'); setNotice({ kind: '', message: '' });
    try {
      const { id } = await storeSnapshot(false);
      const result = await request(`/api/workflows/${id}/validate`, { method: 'POST' });
      setNotice({ kind: 'success', message: `Workflow is valid · ${result.executionOrder.join(' → ')}` });
    } catch (error) { setNotice({ kind: 'error', message: error.message }); }
    finally { setBusy(''); }
  };

  const runWorkflow = async () => {
    if (busy || executionIsActive) return;
    setBusy('run'); setNotice({ kind: '', message: '' }); setPollingError(''); setExecution(null);
    try {
      const { id } = await storeSnapshot(false);
      const started = await request(`/api/workflows/${id}/run`, { method: 'POST' });
      if (!started.executionId) throw new Error('The API did not return an execution ID.');
      if (started.status !== 'queued') throw new Error('The API did not queue this execution.');
      setExecution({ _id: started.executionId, status: started.status, nodeResults: [] });
      setNotice({ kind: 'info', message: `Execution queued · ${started.executionId}` });
    } catch (error) { setNotice({ kind: 'error', message: error.message }); }
    finally { setBusy(''); }
  };

  const removeSelected = () => {
    if (!selectedId) return;
    markEditorTouched();
    setNodes(current => current.filter(node => node.id !== selectedId));
    setEdges(current => current.filter(edge => edge.source !== selectedId && edge.target !== selectedId));
    setSelectedId(null); if (!executionIsActive) setExecution(null);
  };

  const canValidate = workflowName.trim() && nodes.length > 0 && !busy;
  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#editor" aria-label="Flowdesk editor home">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>flowdesk<span className="brand-dot">.</span></span>
        </a>
        <div className="topbar-divider" />
        <label className="workflow-name-wrap">
          <span className="sr-only">Workflow name</span>
          <input className="workflow-name" value={workflowName} onChange={event => { markEditorTouched(); setWorkflowName(event.target.value); if (!executionIsActive) setExecution(null); }} aria-label="Workflow name" />
          <span className={`draft-indicator${isDirty ? ' is-dirty' : ''}`} aria-label={isDirty ? 'Unsaved changes' : savedId ? 'Saved workflow' : 'New workflow'} />
        </label>
        <div className="topbar-spacer" />
        <form className="load-form" onSubmit={loadWorkflow}>
          <label className="sr-only" htmlFor="load-workflow-id">Load workflow by ID</label>
          <input id="load-workflow-id" value={loadId} onChange={event => setLoadId(event.target.value)} placeholder="Workflow ID" />
          <button className="button button-quiet button-load" type="submit" disabled={Boolean(busy) || executionIsActive || !loadId.trim()}>{busy === 'load' ? 'Loading…' : 'Load'}</button>
        </form>
        <button className="button button-outline" onClick={saveWorkflow} disabled={busy || !canValidate}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
        <button className="button button-quiet" onClick={validateWorkflow} disabled={busy || !canValidate}>{busy === 'validate' ? 'Checking…' : 'Validate'}</button>
        <button className="button button-primary" onClick={runWorkflow} disabled={busy || !canValidate || executionIsActive}>{busy === 'run' ? <><span className="spinner" /> Queueing</> : executionIsActive ? <><span className="spinner" /> {execution.status === 'queued' ? 'Queued' : 'Running'}</> : <><span aria-hidden="true">▶</span> Run</>}</button>
      </header>

      <section className="workspace" id="editor">
        <aside className="left-rail" aria-label="Node palette">
          <div className="rail-heading"><span className="eyebrow">BUILD</span><h2>Node library</h2><p>Add a step to your workflow.</p></div>
          <div className="palette-list">
            {palette.map(item => (
              <button key={item.type} className="palette-card" onClick={() => addNode(item.type)} disabled={!available(item.type)} title={!available(item.type) ? `Only one ${item.label.toLowerCase()} node is supported` : `Add ${item.label} node`}>
                <span className={`palette-symbol palette-symbol--${item.type}`} aria-hidden="true">{item.symbol}</span>
                <span className="palette-copy"><strong>{item.label}</strong><small>{item.description}</small></span>
                <span className="palette-plus" aria-hidden="true">+</span>
              </button>
            ))}
          </div>
          <div className="rail-note"><span className="note-mark" aria-hidden="true">i</span><span>Phase 1 graphs support one input, one output and a single path.</span></div>
        </aside>

        <section className="canvas-section" aria-label="Workflow canvas">
          <div className="canvas-toolbar">
            <div><span className="canvas-title">Workflow canvas</span><span className="canvas-subtitle">{nodes.length} nodes <span>·</span> {edges.length} connections</span></div>
            <span className="canvas-hint">Drag nodes to arrange <span aria-hidden="true">↗</span></span>
          </div>
          <div className="canvas-wrap">
            <ReactFlow
              nodes={nodes}
              edges={edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              onNodeClick={(_, node) => setSelectedId(node.id)}
              onPaneClick={() => setSelectedId(null)}
              onNodeDragStop={(_, draggedNode) => savedId && savePositions(savedId, nodes.map(node => node.id === draggedNode.id ? { ...node, position: draggedNode.position } : node))}
              isValidConnection={connection => !connectionIssue(connection, nodes, edges)}
              fitView
              fitViewOptions={{ padding: 0.22 }}
              deleteKeyCode={['Backspace', 'Delete']}
              nodesConnectable
              edgesFocusable
              nodesFocusable
              ariaLabel="Interactive workflow canvas"
              proOptions={{ hideAttribution: true }}
            >
              <Background color="#dfe3e8" gap={22} size={1.25} />
              <MiniMap nodeColor={node => ({ input: '#4c7af2', transform: '#8b63dc', condition: '#e4a132', ai: '#268ca0', output: '#28a57b' }[node.data?.workflowType] || '#ccd2da')} maskColor="rgba(247, 248, 250, .76)" />
              <Controls position="bottom-left" showInteractive={false} />
            </ReactFlow>
            {nodes.length === 0 && <div className="canvas-empty" aria-live="polite"><div className="empty-illustration"><span>↳</span><i /><span>↗</span></div><h2>Start with a node</h2><p>Add an input, then connect each step to the next.</p><button className="button button-outline" onClick={() => addNode('input')}>＋ Add input node</button></div>}
          </div>
          <div className="canvas-footer"><span><i className="legend-dot legend-dot--input" />Input</span><span><i className="legend-dot legend-dot--transform" />Transform</span><span><i className="legend-dot legend-dot--condition" />Condition</span><span><i className="legend-dot legend-dot--ai" />AI</span><span><i className="legend-dot legend-dot--output" />Output</span><span className="footer-spacer" /><span className="keyboard-help"><kbd>Delete</kbd> removes selected node</span></div>
        </section>

        <aside className="right-rail" aria-label="Node settings and execution results">
          <div className="detail-panel">
            <div className="panel-heading"><span className="eyebrow">CONFIGURE</span><h2>{selectedNode ? 'Node settings' : 'Properties'}</h2></div>
            {selectedNode ? (
              <div className="config-form">
                <div className="selected-node-title"><span className={`tiny-node-icon tiny-node-icon--${selectedNode.data.workflowType}`}>{palette.find(item => item.type === selectedNode.data.workflowType)?.symbol}</span><div><strong>{selectedNode.data.workflowType[0].toUpperCase() + selectedNode.data.workflowType.slice(1)}</strong><small>Node ID · {selectedNode.id}</small></div></div>
                {selectedNode.data.workflowType === 'input' && <label className="field-label">Text to process<textarea value={selectedNode.data.config.text} onChange={event => updateConfig('text', event.target.value)} rows="5" placeholder="Enter text" /><small>Passed to the next connected node as <code>text</code>.</small></label>}
                {selectedNode.data.workflowType === 'transform' && <div className="field-stack"><p className="field-intro">Clean up text before checking it.</p><label className="check-field"><input type="checkbox" checked={selectedNode.data.config.trim} onChange={event => updateConfig('trim', event.target.checked)} /><span><strong>Trim edges</strong><small>Remove whitespace at the beginning and end.</small></span></label><label className="check-field"><input type="checkbox" checked={selectedNode.data.config.normalizeWhitespace} onChange={event => updateConfig('normalizeWhitespace', event.target.checked)} /><span><strong>Normalize whitespace</strong><small>Replace repeated whitespace with one space.</small></span></label></div>}
                {selectedNode.data.workflowType === 'condition' && <label className="field-label">Condition<select value={selectedNode.data.config.operator} onChange={event => updateConfig('operator', event.target.value)}><option value="nonEmpty">Text is not empty</option></select><small>Returns <code>passed</code> and the normalized text.</small></label>}
                {selectedNode.data.workflowType === 'ai' && <div className="field-stack"><label className="field-label">Instruction<textarea value={selectedNode.data.config.instruction} onChange={event => updateConfig('instruction', event.target.value)} rows="5" maxLength="4000" placeholder="Describe the response you want" /><small>Up to 4,000 characters. Runs through the configured local Ollama model.</small></label><label className="field-label">Response format<select value={selectedNode.data.config.responseFormat} onChange={event => updateConfig('responseFormat', event.target.value)}><option value="text">Text</option><option value="json">JSON</option></select><small>JSON responses are checked before they are accepted.</small></label></div>}
                {selectedNode.data.workflowType === 'output' && <div className="output-contract"><span className="output-check">✓</span><div><strong>Workflow result</strong><p>Returns a condition result or the AI response and model metadata.</p><code>{'{ passed, text } · { response, model, latencyMs }'}</code></div></div>}
                <button className="button button-danger-quiet remove-button" onClick={removeSelected}>Remove node</button>
              </div>
            ) : <div className="panel-empty"><span className="selection-mark">⌖</span><strong>Select a node</strong><p>Choose a node on the canvas to view and edit its settings.</p></div>}
          </div>

          <div className="run-panel">
            <div className="panel-heading run-heading"><div><span className="eyebrow">LATEST RUN</span><h2>Execution</h2></div>{execution && <span className={`status-pill status-pill--${execution.status}`}>{execution.status}</span>}</div>
            {!execution ? <div className="run-empty"><span className="run-empty-icon" aria-hidden="true">◷</span><p>Run your workflow to see node outputs and status here.</p></div> : (
              <div className="execution-view">
                <div className="execution-id"><small>Execution ID</small><code title={execution._id}>{execution._id}</code></div>
                {execution.error && <div className="execution-error" role="alert">{execution.error}</div>}
                {pollingError && executionIsActive && <div className="execution-error" role="status">Status check failed temporarily: {pollingError} Polling will continue.</div>}
                <div className="execution-nodes">
                  {execution.nodeResults?.map(item => (
                    <details className={`execution-node execution-node--${item.status}`} key={item.nodeId} open={item.status === 'failed'}>
                      <summary><span className="result-state" aria-hidden="true">{item.status === 'succeeded' ? '✓' : item.status === 'failed' ? '!' : item.status === 'running' ? '…' : '·'}</span><span>{item.nodeId}</span><small>{item.status}</small></summary>
                      <div className="result-body">
                        {item.error && <p className="result-error">{item.error}</p>}
                        {item.errorCategory && <small>Error category · {item.errorCategory}</small>}
                        {item.elapsedMs !== undefined && <small>Elapsed · {item.elapsedMs} ms</small>}
                        {item.output !== undefined && <><small>Output</small><pre>{JSON.stringify(item.output, null, 2)}</pre></>}
                      </div>
                    </details>
                  ))}
                </div>
                {execution.result !== undefined && <div className="final-result"><small>Final result</small><pre>{JSON.stringify(execution.result, null, 2)}</pre></div>}
              </div>
            )}
          </div>
        </aside>
      </section>

      <div className={`toast toast--${notice.kind || 'hidden'}`} role={notice.kind === 'error' ? 'alert' : 'status'} aria-live={notice.kind === 'error' ? 'assertive' : 'polite'}>
        {notice.message && <><span className="toast-icon" aria-hidden="true">{notice.kind === 'error' ? '!' : notice.kind === 'success' ? '✓' : 'i'}</span><span>{notice.message}</span><button aria-label="Dismiss message" onClick={() => setNotice({ kind: '', message: '' })}>×</button></>}
      </div>
    </main>
  );
}

function App() {
  return <ReactFlowProvider><Editor /></ReactFlowProvider>;
}

createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);
