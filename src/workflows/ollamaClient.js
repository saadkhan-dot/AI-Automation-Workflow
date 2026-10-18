const { NodeExecutionError } = require('./nodeRegistry');

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'llama3.2';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TEXT_LENGTH = 20000;

function getOllamaConfig(env = process.env) {
  const baseUrl = env.OLLAMA_BASE_URL || DEFAULT_BASE_URL;
  let parsed;
  try { parsed = new URL(baseUrl); } catch { throw new Error('OLLAMA_BASE_URL must be a valid HTTP URL'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('OLLAMA_BASE_URL must be an HTTP URL without credentials, query, or fragment');
  }
  const model = env.OLLAMA_MODEL || DEFAULT_MODEL;
  if (typeof model !== 'string' || !model.trim() || model.length > 128) throw new Error('OLLAMA_MODEL must be a non-empty model name up to 128 characters');
  const timeoutMs = env.AI_TIMEOUT_MS === undefined || env.AI_TIMEOUT_MS === '' ? DEFAULT_TIMEOUT_MS : Number(env.AI_TIMEOUT_MS);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) {
    throw new Error('AI_TIMEOUT_MS must be an integer from 1000 to 120000');
  }
  return { baseUrl: parsed.toString().replace(/\/$/, ''), model: model.trim(), timeoutMs };
}

function providerError(message, category) { return new NodeExecutionError(message, category); }

async function generateText({ text, instruction, responseFormat = 'text' }, options = {}) {
  if (typeof text !== 'string' || text.length > MAX_TEXT_LENGTH) throw providerError('AI input must be text up to 20000 characters', 'invalid_input');
  if (typeof instruction !== 'string' || !instruction.trim() || instruction.length > 4000) throw providerError('AI instruction is invalid', 'invalid_configuration');
  if (!['text', 'json'].includes(responseFormat)) throw providerError('AI response format is invalid', 'invalid_configuration');

  let config;
  try { config = options.config || getOllamaConfig(options.env); }
  catch { throw providerError('Ollama provider configuration is invalid', 'provider_configuration'); }
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw providerError('Ollama is unavailable', 'unavailable');
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || config.timeoutMs;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const start = Date.now();
  try {
    const response = await fetchImpl(`${config.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        model: config.model,
        stream: false,
        ...(responseFormat === 'json' ? { format: 'json' } : {}),
        prompt: `Instruction:\n${instruction.trim()}\n\nText:\n${text}`,
      }),
    });
    if (!response || !response.ok) {
      if (response && response.status === 404) throw providerError('Configured Ollama model is unavailable', 'model_unavailable');
      throw providerError('Ollama request failed', 'unavailable');
    }
    let body;
    try { body = await response.json(); } catch { throw providerError('Ollama returned an invalid response', 'invalid_response'); }
    if (!body || typeof body.response !== 'string' || !body.response.trim() || body.response.length > MAX_TEXT_LENGTH) {
      throw providerError('Ollama returned an invalid response', 'invalid_response');
    }
    if (responseFormat === 'json') {
      try { JSON.parse(body.response); } catch { throw providerError('Ollama response did not match JSON format', 'invalid_output'); }
    }
    return { response: body.response, model: typeof body.model === 'string' && body.model ? body.model : config.model, latencyMs: Math.max(0, Date.now() - start) };
  } catch (error) {
    if (error instanceof NodeExecutionError) throw error;
    if (controller.signal.aborted || error?.name === 'AbortError') throw providerError('Ollama request timed out', 'timeout');
    throw providerError('Ollama is unavailable', 'unavailable');
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { generateText, getOllamaConfig, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_TIMEOUT_MS };
