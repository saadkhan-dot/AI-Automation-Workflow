import React from 'react';
import { Handle, Position } from '@xyflow/react';

const labels = {
  input: 'Input',
  transform: 'Transform',
  condition: 'Condition',
  ai: 'AI',
  output: 'Output',
};

function summary(type, config) {
  if (type === 'input') return config.text ? `“${config.text.slice(0, 32)}${config.text.length > 32 ? '…' : ''}”` : 'Text input';
  if (type === 'transform') return 'Trim · normalize whitespace';
  if (type === 'condition') return 'Text is non-empty';
  if (type === 'ai') return config.instruction ? config.instruction.slice(0, 40) : 'Add an instruction';
  return 'Return condition and text';
}

export default function WorkflowNode({ id, data, selected }) {
  const type = data.workflowType;
  return (
    <article className={`workflow-node workflow-node--${type}${selected ? ' is-selected' : ''}`} aria-label={`${labels[type]} node ${id}`}>
      {type !== 'input' && <Handle type="target" position={Position.Top} aria-label={`${labels[type]} input`} />}
      <div className="node-topline">
        <span className={`node-icon node-icon--${type}`} aria-hidden="true">{type === 'input' ? '↳' : type === 'transform' ? '⌁' : type === 'condition' ? '?' : type === 'ai' ? '✳' : '↗'}</span>
        <span className="node-type">{labels[type]}</span>
        <span className="node-port" aria-hidden="true">{type === 'input' ? 'IN' : type === 'output' ? 'OUT' : 'STEP'}</span>
      </div>
      <div className="node-id">{id}</div>
      <div className="node-summary">{summary(type, data.config)}</div>
      {type !== 'output' && <Handle type="source" position={Position.Bottom} aria-label={`${labels[type]} output`} />}
    </article>
  );
}
