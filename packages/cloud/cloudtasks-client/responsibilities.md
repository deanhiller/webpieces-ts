# Responsibilities — cloudtasks-client

Cloud Tasks enqueue client generated from a shared `@PubSub` API contract — the fire-and-forget twin of http-client. Owns the enqueue proxy, the scheduler, and the TaskInvoker transports (GCP + in-memory), both of which deliver a task over real HTTP.

## In Scope

- Enqueue client generation from a `@PubSub` contract (`ClientCloudTasksFactory.createClient`, `TaskProxyClient`, `TaskClientConfig`)
- `CloudTaskScheduler` (addToQueue / schedule / cancelJob) + the out-of-band schedule-frame bridge
- `TaskInvoker` abstraction and impls: `GcpTaskInvoker` (real @google-cloud/tasks) and `InMemoryTaskInvoker` (in-process queue that delivers via a real HTTP `fetch` to `targetUrl + path`, e.g. `localhost:{port}`, for tests/local dev)

## Out of Scope

- GCP identity/metadata/OIDC primitives (that is gcp-identity)
- Generic HTTP routing/server bootstrap (http-routing / http-server)
- Server-side delivery pieces: the `ServiceAuthFilter` (@AuthOidc/@AuthSharedSecret enforcement) and any in-process route dispatch — a client library has NO server filters or routing machinery; those live in http-server
- Synchronous RPC client generation (http-client)

## Notes

- Node-only. Shares ONE abstract API class between the enqueue client and the controller, exactly like RPC.
- API methods take ONLY the business request. Queue/scheduling knobs (dedupName, run-in-the-future, taskTimeoutSeconds, cancel) are per-enqueue transport concerns the delivered controller cannot use, so they live on `CloudTaskScheduler` / `ScheduleOptions`, never on a `@PubSub` method. Adding them to an API method is a design error.
