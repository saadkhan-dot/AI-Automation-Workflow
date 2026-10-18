class NodeExecutionError extends Error {
  constructor(message, category) { super(message); this.name = 'NodeExecutionError'; this.category = category; }
}

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NodeExecutionError(`${label} must be an object`);
  return value;
}

function validateNodeConfig(type, config) {
  requireObject(config, 'config');
  const allowed = {
    input: ['text'],
    transform: ['trim', 'normalizeWhitespace'],
    condition: ['operator'],
    ai: ['instruction', 'responseFormat'],
    output: [],
  }[type];
  if (!allowed) throw new NodeExecutionError(`Unsupported node type: ${String(type)}`);
  if (Object.keys(config).some(key => !allowed.includes(key))) throw new NodeExecutionError(`Invalid ${type} node config`);
  if (type === 'input' && typeof config.text !== 'string') throw new NodeExecutionError('input config.text must be a string');
  if (type === 'transform' && ['trim', 'normalizeWhitespace'].some(key => key in config && typeof config[key] !== 'boolean')) {
    throw new NodeExecutionError('transform trim and normalizeWhitespace options must be booleans');
  }
  if (type === 'condition' && config.operator !== undefined && config.operator !== 'nonEmpty') {
    throw new NodeExecutionError('condition operator must be nonEmpty');
  }
  if (type === 'ai') {
    if (typeof config.instruction !== 'string' || !config.instruction.trim() || config.instruction.length > 4000) {
      throw new NodeExecutionError('ai config.instruction must be a non-empty string up to 4000 characters');
    }
    if (config.responseFormat !== undefined && !['text', 'json'].includes(config.responseFormat)) {
      throw new NodeExecutionError('ai config.responseFormat must be text or json');
    }
  }
  return config;
}

function requireInputs(inputs, type, count) {
  if (!Array.isArray(inputs)) throw new NodeExecutionError(`${type} inputs must be an array`);
  if (inputs.length !== count) throw new NodeExecutionError(`${type} requires exactly ${count} input value${count === 1 ? '' : 's'}`);
  return inputs;
}

const registry = Object.freeze({
  input: ({ config, inputs }) => {
    validateNodeConfig('input', config);
    requireInputs(inputs, 'input', 0);
    return { text: config.text };
  },
  transform: ({ inputs, config }) => {
    validateNodeConfig('transform', config);
    requireInputs(inputs, 'transform', 1);
    const source = inputs[0];
    if (!source || typeof source.text !== 'string') throw new NodeExecutionError('transform requires upstream text output');
    const trim = config.trim !== false;
    const normalizeWhitespace = config.normalizeWhitespace !== false;
    let text = source.text;
    if (trim) text = text.trim();
    if (normalizeWhitespace) text = text.replace(/\s+/g, ' ');
    return { text };
  },
  condition: ({ inputs, config }) => {
    validateNodeConfig('condition', config);
    requireInputs(inputs, 'condition', 1);
    const source = inputs[0];
    if (!source || typeof source.text !== 'string') throw new NodeExecutionError('condition requires upstream text output');
    return { passed: source.text.length > 0, text: source.text };
  },
  ai: async ({ inputs, config }) => {
    validateNodeConfig('ai', config);
    requireInputs(inputs, 'ai', 1);
    const source = inputs[0];
    if (!source || typeof source.text !== 'string') throw new NodeExecutionError('ai requires upstream text output');
    const { generateText } = require('./ollamaClient');
    return generateText({ text: source.text, instruction: config.instruction, responseFormat: config.responseFormat });
  },
  output: ({ inputs, config }) => {
    validateNodeConfig('output', config);
    requireInputs(inputs, 'output', 1);
    const value = inputs[0];
    if (value && typeof value.passed === 'boolean' && typeof value.text === 'string') return { passed: value.passed, text: value.text };
    if (value && typeof value.response === 'string' && typeof value.model === 'string' && Number.isFinite(value.latencyMs)) {
      return { response: value.response, model: value.model, latencyMs: value.latencyMs };
    }
    throw new NodeExecutionError('output requires connected condition or AI output');
  },
});

function executeNode(type, context) {
  const implementation = Object.hasOwn(registry, type) ? registry[type] : undefined;
  if (!implementation) throw new NodeExecutionError(`Unsupported node type: ${String(type)}`);
  return implementation(context);
}

module.exports = { executeNode, validateNodeConfig, NodeExecutionError };
