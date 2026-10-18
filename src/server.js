const mongoose = require('mongoose');
const { createApp } = require('./app');
const { mongoUri, port } = require('./config');

async function start() {
  await mongoose.connect(mongoUri);
  const server = createApp().listen(port, () => console.log(`Workflow API listening on port ${port}`));
  const shutdown = async () => {
    server.close(async () => { await mongoose.disconnect(); process.exit(0); });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  start().catch(error => { console.error('Unable to start workflow API:', error.message); process.exit(1); });
}

module.exports = { start };
