export const LAST_WORKFLOW_ID_KEY = 'flowdesk:last-workflow-id';

function storageOrGlobal(storage) {
  return storage ?? globalThis.localStorage;
}

export function rememberWorkflowId(id, storage) {
  if (typeof id !== 'string' || !id.trim()) return false;
  try {
    storageOrGlobal(storage).setItem(LAST_WORKFLOW_ID_KEY, id);
    return true;
  } catch { return false; }
}

export function readRememberedWorkflowId(storage) {
  try { return storageOrGlobal(storage).getItem(LAST_WORKFLOW_ID_KEY) || ''; }
  catch { return ''; }
}

export function clearRememberedWorkflowId(expectedId, storage) {
  try {
    const target = storageOrGlobal(storage);
    if (target.getItem(LAST_WORKFLOW_ID_KEY) !== expectedId) return false;
    target.removeItem(LAST_WORKFLOW_ID_KEY);
    return true;
  } catch { return false; }
}

export function workflowPositionsKey(workflowId) {
  return `flowdesk:positions:${workflowId}`;
}

export function readWorkflowPositions(workflowId, storage) {
  if (!workflowId) return {};
  try { return JSON.parse(storageOrGlobal(storage).getItem(workflowPositionsKey(workflowId)) || '{}'); }
  catch { return {}; }
}

export function saveWorkflowPositions(workflowId, positions, storage) {
  if (!workflowId) return false;
  try {
    storageOrGlobal(storage).setItem(workflowPositionsKey(workflowId), JSON.stringify(positions));
    return true;
  } catch { return false; }
}

export function canApplyRestoredWorkflow(hasUnsavedChanges) {
  return !hasUnsavedChanges;
}

export async function fetchAndRememberWorkflow(workflowId, { storage, fetchWorkflow }) {
  const workflow = await fetchWorkflow(workflowId);
  rememberWorkflowId(workflow._id, storage);
  return workflow;
}

export async function restoreRememberedWorkflow({ storage, fetchWorkflow, hasUnsavedChanges, onRestore }) {
  const workflowId = readRememberedWorkflowId(storage);
  if (!workflowId) return { status: 'empty' };

  let workflow;
  try { workflow = await fetchWorkflow(workflowId); }
  catch (error) {
    const missing = error.status === 400 || error.status === 404;
    if (missing) clearRememberedWorkflowId(workflowId, storage);
    return { status: missing ? 'missing' : 'unavailable', workflowId, error };
  }

  const dirty = typeof hasUnsavedChanges === 'function' ? hasUnsavedChanges() : Boolean(hasUnsavedChanges);
  if (!canApplyRestoredWorkflow(dirty)) return { status: 'preserved', workflowId };
  rememberWorkflowId(workflow._id, storage);
  onRestore(workflow);
  return { status: 'restored', workflowId, workflow };
}
