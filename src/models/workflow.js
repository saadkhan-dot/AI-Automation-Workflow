const mongoose = require('mongoose');

const workflowSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  nodes: { type: [mongoose.Schema.Types.Mixed], required: true },
  edges: { type: [mongoose.Schema.Types.Mixed], required: true },
}, { timestamps: true, versionKey: false, minimize: false });

module.exports = mongoose.models.Workflow || mongoose.model('Workflow', workflowSchema);
