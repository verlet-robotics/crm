// Single-process entry that runs BOTH the queue worker and the HTTP trigger
// server. Use this when you want one Railway service instead of two (cheaper,
// simpler). For higher throughput, run `queue:worker` and `trigger:server` as
// separate services sharing the same Redis instead.
//
// Importing each module runs its top-level bootstrap (the worker starts its
// BullMQ Workers; the trigger server starts listening). Both register their own
// SIGINT/SIGTERM handlers, which is fine — on shutdown each closes its own
// resources.
import '../queue/worker.js';
import './trigger-server.js';
