# AI Workflow Automation — Phases 1–4

A workflow API and execution engine built with Node.js, Express, and MongoDB, with a React visual editor using Vite and `@xyflow/react`. The allowlisted AI node calls a local Ollama server. There is no code execution node, scheduler, or branching execution.

## Requirements and setup

- Node.js 20 or newer
- MongoDB running locally or a reachable MongoDB URI

```sh
npm install
cp .env.example .env
# Edit MONGODB_URI if your MongoDB is not local.
npm start
```

The API listens on `PORT` (default `3000`). `MONGODB_URI` selects the database. AI provider settings are `OLLAMA_BASE_URL` (default `http://localhost:11434`), `OLLAMA_MODEL` (default `llama3.2`), and `AI_TIMEOUT_MS` (default `30000`, allowed range 1000–120000). Install/start Ollama and pull a model separately; the app never starts Ollama or downloads a model. `.env` is ignored by git; do not put secrets in workflow fields.

Start a worker in another terminal after the API and MongoDB are running:

```sh
npm run worker
```

Workers poll the MongoDB queue and claim jobs with an atomic `queued` → `running` update. Configure `WORKER_CONCURRENCY` (default `2`, range 1–32), `WORKER_POLL_INTERVAL_MS` (default `500`, range 100–60000), and `WORKER_LEASE_TIMEOUT_MS` (default `60000`, range 5000–600000). Each worker refreshes its running-job heartbeat. A stale running job is marked failed as `worker_lost` and is not retried because a node with an external side effect may already have run.

### Queue architecture and failure policy

The execution document is both the persisted execution record and durable work queue, avoiding a required Redis service and a separate enqueue transaction. `POST /api/workflows/:id/run` validates and inserts a `queued` execution; MongoDB insertion is the enqueue operation, so a failed insert creates no orphan queue item. The worker claims with `findOneAndUpdate` on `status: queued`, which prevents two workers from claiming the same record concurrently. MongoDB indexes support queued selection and stale lease scanning.

BullMQ with Redis would provide mature queue operations, delayed jobs, rate limiting, and queue observability, but would add a required service and still require coordinating workflow status with MongoDB. For this project's existing single persistence dependency, the Mongo-backed queue is smaller and keeps the status record authoritative. Its tradeoff is periodic polling and throughput bounded by MongoDB; it does not provide exactly-once external side effects. There are no automatic execution retries. Crashes leave a running lease that is eventually failed, never silently replayed.

## Visual editor

Install the editor dependencies and run Vite in a second terminal while the backend and MongoDB are running:

```sh
npm --prefix client install
npm run dev:client
```

Optionally copy `client/.env.example` to `client/.env` to configure the API. Open `http://localhost:5173`. Vite proxies `/api` and `/health` to `http://localhost:3000` by default. For another local backend, set `VITE_API_PROXY_TARGET`. For a deployed or separately hosted API, set `VITE_API_BASE_URL` at build time. A separate production origin must provide the needed browser CORS policy or a same-origin reverse proxy. No credentials or production secrets belong in frontend environment variables.

The editor uses the existing workflow routes. Run now receives `202 Accepted` with `{ executionId, status: "queued" }` and polls `GET /api/executions/:executionId` once per second until it sees `succeeded` or `failed`. Polling errors leave the current execution state visible and retry; unmounting stops the timer. The API has no workflow update endpoint, so saving an edited workflow creates a new stored snapshot. Validate and Run save a changed snapshot first. The workflow definition contains only `name`, `nodes` (`id`, `type`, `config`), and `edges` (`from`, `to`). Canvas positions stay in browser local storage by workflow ID. Startup restoration and unsaved-edit safeguards remain in place.

The palette exposes `input`, `transform`, `condition`, `ai`, and `output`. The editor prevents branching, duplicate inputs, incompatible connections, and cycles where possible; the backend remains authoritative. Node IDs remain stable while editing and saving. Existing saved workflows can be loaded by their MongoDB ID from the header.

Frontend checks and build:

```sh
npm test
npm run build:client
```

## Example workflow and API

The canonical example definition is in `src/workflows/examples.js` and `examples/workflow.json`:

```json
{
  "name": "Normalize text and check it is non-empty",
  "nodes": [
    { "id": "input", "type": "input", "config": { "text": "  Hello    workflow  " } },
    { "id": "normalize", "type": "transform", "config": { "trim": true, "normalizeWhitespace": true } },
    { "id": "check", "type": "condition", "config": { "operator": "nonEmpty" } },
    { "id": "output", "type": "output", "config": {} }
  ],
  "edges": [
    { "from": "input", "to": "normalize" },
    { "from": "normalize", "to": "check" },
    { "from": "check", "to": "output" }
  ]
}
```

```sh
curl http://localhost:3000/health
curl -X POST http://localhost:3000/api/workflows -H 'content-type: application/json' --data-binary @examples/workflow.json
curl http://localhost:3000/api/workflows/WORKFLOW_ID
curl -X POST http://localhost:3000/api/workflows/WORKFLOW_ID/validate
curl -X POST http://localhost:3000/api/workflows/WORKFLOW_ID/run
curl http://localhost:3000/api/executions/EXECUTION_ID
```

`POST /api/workflows` validates and stores a definition (201). Validation errors return 400 with details. Run returns an execution ID and `queued` status (202); execution details expose `queued`, `running`, `succeeded`, or `failed` plus node progress. Missing resources return 404. `GET /health` reports API process health; database connection is required before the API or worker starts.

## Node contracts

All nodes have a stable string `id`, allowlisted `type`, and object `config`. A node receives outputs from its incoming edges in edge order and returns a JSON-compatible object.

| Type | Configuration | Output |
| --- | --- | --- |
| `input` | `{ "text": string }` | `{ "text": string }` |
| `transform` | `{ "trim"?: boolean, "normalizeWhitespace"?: boolean }`; both default to true | `{ "text": string }` after optional trim and whitespace collapse |
| `condition` | `{ "operator"?: "nonEmpty" }` | `{ "passed": boolean, "text": string }`; `passed` tests whether upstream text is non-empty |
| `ai` | `{ "instruction": string, "responseFormat"?: "text" | "json" }` | `{ "response": string, "model": string, "latencyMs": number }` |
| `output` | `{}` | Copies either the condition result `{ "passed": boolean, "text": string }` or AI result `{ "response": string, "model": string, "latencyMs": number }` |

Each workflow has exactly one input and one output. Every non-input node accepts one incoming edge, input cannot have parents, output cannot have children, and branching is rejected. DAGs execute sequentially in deterministic topological order. A node moves through `running` to `succeeded` or `failed`; downstream nodes become `skipped` on failure. A workflow succeeds only after all its nodes succeed. Terminal execution states cannot transition again. No user-supplied function name is loaded and no `eval` or shell execution is used. AI instructions and upstream text are sent only to the configured Ollama endpoint. Prompts are not logged or copied into execution history; the validated response and latency are persisted. Provider failures use sanitized messages and categories.

## Architecture

- `src/workflows/validator.js` validates definitions and uses Kahn's algorithm to reject cycles and produce execution order.
- `src/workflows/nodeRegistry.js` is the fixed allowlist and owns node contracts.
- `src/workflows/executor.js` passes predecessor outputs, reports node progress, and stops after failure.
- `src/workflows/worker.js` atomically claims persisted execution records, runs them, heartbeats leases, and fails stale jobs without retry.
- `src/models` stores workflow definitions and lifecycle-timestamped execution records in Mongoose.
- `src/app.js` contains the HTTP API; `src/server.js` connects MongoDB before listening.

The output node consumes its immediate connected condition or AI result. API and workers are separate processes; if no worker is running, requests remain durably queued until one starts.

## Tests

```sh
npm test
```

The integration test starts a local `mongod` on a free port with a temporary data directory and the isolated database name `workflow_test_isolated`, then removes that temporary directory. Set `MONGOD_BIN` if the binary is not named `mongod` or is not on `PATH`. It does not connect to or remove data from the application database.
