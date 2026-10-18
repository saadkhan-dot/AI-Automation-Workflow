const mongoose = require('mongoose');

const nodeResultSchema = new mongoose.Schema({
  nodeId: { type: String, required: true },
  status: { type: String, enum: ['running', 'succeeded', 'failed', 'skipped'], required: true },
  input: mongoose.Schema.Types.Mixed,
  output: mongoose.Schema.Types.Mixed,
  error: String,
  errorCategory: String,
  elapsedMs: Number,
  startedAt: Date,
  finishedAt: Date,
}, { _id: false });

const executionSchema = new mongoose.Schema({
  workflowId: { type: mongoose.Schema.Types.ObjectId, ref: 'Workflow', required: true },
  status: { type: String, enum: ['queued', 'running', 'succeeded', 'failed'], required: true },
  nodeResults: { type: [nodeResultSchema], default: [] },
  result: mongoose.Schema.Types.Mixed,
  error: String,
  errorCategory: String,
  startedAt: Date,
  finishedAt: Date,
  workerId: { type: String, select: false },
  heartbeatAt: { type: Date, select: false },
}, { timestamps: true, versionKey: false });

executionSchema.index({ status: 1, createdAt: 1 });
executionSchema.index({ status: 1, heartbeatAt: 1 });

module.exports = mongoose.models.Execution || mongoose.model('Execution', executionSchema);
