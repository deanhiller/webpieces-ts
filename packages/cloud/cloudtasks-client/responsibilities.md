# Responsibilities — cloudtasks-client

Cloud Tasks enqueue client generated from a shared `@PubSub` API contract — the fire-and-forget twin of http-client. Owns the enqueue proxy, the scheduler, the TaskInvoker abstraction (GCP + in-memory), and the `@PubSub` delivery pieces (in-process dispatcher + service-auth filter).

## In Scope

- Enqueue client generation from a `@PubSub` contract (`createTaskClient`, `TaskClientCreator`)
- `CloudTaskScheduler` (addToQueue / schedule / cancelJob) + the out-of-band schedule-frame bridge
- `TaskInvoker` abstraction and impls: `GcpTaskInvoker` (real @google-cloud/tasks), `InMemoryTaskInvoker` (in-process dispatch through the real filter chain)
- `@PubSub` delivery: `LocalTaskDispatcherImpl` (runs a delivered task through the route filter chain) and `ServiceAuthFilter` (@AuthOidc / @AuthSharedSecret enforcement)

## Out of Scope

- GCP identity/metadata/OIDC primitives (that is gcp-identity)
- Generic HTTP routing/server bootstrap (http-routing / http-server)
- Synchronous RPC client generation (http-client)

## Notes

- Node-only. Shares ONE abstract API class between the enqueue client and the controller, exactly like RPC.
- API methods take ONLY the business request. Queue/scheduling knobs (dedupName, run-in-the-future, taskTimeoutSeconds, cancel) are per-enqueue transport concerns the delivered controller cannot use, so they live on `CloudTaskScheduler` / `ScheduleOptions`, never on a `@PubSub` method. Adding them to an API method is a design error.
