# @webpieces/cloudtasks-client

The Cloud Tasks twin of `@webpieces/http-client`. A `@PubSub` API contract is shared
by the enqueue client and the controller, exactly like RPC — calling a method on the
client **enqueues a Cloud Task** that is later delivered (POST) to the SAME endpoint,
where it runs through the full server filter chain.

```ts
// one shared contract
@PubSub() @ApiPath('/email')
abstract class EmailApi {
    @Endpoint(POST, '/send', WRITE, CLOUDTASKS)
    @WpAuth([oidcSameProject()])
    @WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY })
    abstract sendEmail(r: SendEmailRequest): Promise<void>;
}

// build the client once (sync); 'email-svc' is the callee's Cloud Run service name
const emailTasks = factory.createPubSubClient(EmailApi, new TaskClientConfig('email-svc'));

// producer (inside a request → RequestContext active)
await scheduler.addToQueue(() => emailTasks.sendEmail(req));                                        // retried, auto-named
await scheduler.addToQueue(() => emailTasks.sendEmail(req), new ScheduleOptions(TaskName.dedup(req.id), 900));
await scheduler.schedule(() => emailTasks.sendEmail(req), Date.now() + 60_000, new ScheduleOptions(TaskName.dedup(req.id)));
```

- `ClientCloudTasksFactory.createPubSubClient(Api, TaskClientConfig)` — builds the enqueue proxy. It
  injects a `Provider<TaskProxyClient>` and calls `get()` per contract; `TaskProxyClient` is bound
  TRANSIENT, so each client gets its own. The delivery URL is resolved at enqueue time from `svcName`
  through `ClientRegistry.resolve` — the SAME chain the RPC client runs: a registered mapping wins,
  else the installed deriver (`ClientRegistry.setDeriver(gcpCloudRunDeriver())` on GCP), else it
  throws, because an unresolvable target is a setup bug. Register non-derivable URLs (localhost,
  cross-region, non-Cloud-Run) once at startup with `ClientRegistry.addMapping(svcName, port)` /
  `addUrlMapping(svcName, url)`
- An enqueue outside `RequestContext.run(...)` **throws**: a task with no caller trace is a bug
- `CloudTaskScheduler` — `addToQueue` / `schedule` / `cancelJob`; carries scheduling
  options out-of-band so the contract signature stays identical on both sides
- `TaskInvoker` (abstract token) with two impls, each making ONE attempt per call:
  - `GcpTaskInvoker` — real `@google-cloud/tasks` 6.3.0 (google-gax 5) delivery (OIDC / shared-secret)
  - `InMemoryTaskInvoker` — delivers over real HTTP to the target's filter chain (tests + local dev,
    no GCP, production parity); ignores the customizer and gax, but still runs the same retry paths

## Enqueue retries (this is ENQUEUE, not delivery)

The `createTask` gRPC call is retried by webpieces' shared `RetryStrategy` — the same
`CallRegistry.execute` the RPC clients use, with the enqueue transport default
`RetryStrategy(5_000, 3, 500, 2, 4_000)`: 5 s per attempt, 3 retries, backoff 500 ms ×2 capped at
4 s. Only a transient failure is retried (gRPC UNAVAILABLE, DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED →
`GrpcErrorMapper`); giving up throws a 502 `ApiRetriesExhaustedError`. Each retried attempt logs
`WARN [API-client-attempt-TRANSIENT]`. Delivery retries (Cloud Tasks re-POSTing the target) are the
queue's `retryConfig` and are out of scope here.

Retries are safe because every enqueue is NAMED ONCE, before the first attempt:

| `ScheduleOptions.taskName` | name | a retry after a lost response |
|---|---|---|
| `TaskName.generated()` (default) | one UUID per logical enqueue | ALREADY_EXISTS → success |
| `TaskName.dedup(key)` | your key (MessageSid, org+period, …): true dedup across callers | ALREADY_EXISTS → success |
| `TaskName.serverAssigned()` | none — fastest `createTask` | may create a duplicate |

ALREADY_EXISTS is success: `WARN [ENQUEUE-DEDUP]`, and the `JobReference` comes back with
`alreadyExisted: true`. Delete any hand-rolled `isAlreadyExists` catch. A used name stays blocked
for about an hour after its task runs or is deleted.

## Three levels of Google settings

```ts
new ScheduleOptions(taskName, taskTimeoutSeconds?, customizeTask?, gax?)
```

- **`customizeTask`** (or `GcpTaskRegistry.setCustomizer(c, ...scope)`) — the Google
  `ICreateTaskRequest`, run LAST on every attempt's freshly built request. Request only, never timing.
  Call site wins over the registry (method → API → ALL).
- **`gax`** (or `GcpTaskRegistry.setGax(options, ...scope)`) — `CallOptions` for the one `createTask`
  RPC. **Set ⇒ you own timing:** no webpieces strategy, ONE attempt, `createTask(request, yourGax)`
  as given, under a safety cap from `CallRegistry`'s timeout ladder (method → API → ALL → 30 s). Raise
  the cap with `CallRegistry.setTimeout(60_000, EmailApi)` to give gax retries room. Exactly one retry
  layer per enqueue — ours or gax's, never both.
- **The client** — override `CloudTasksClientProvider` for channel/client settings:

```ts
class KeepaliveCloudTasks extends CloudTasksClientProvider {
    override create(): CloudTasksClient {
        return new CloudTasksClient({ 'grpc.keepalive_time_ms': 30_000 });
    }
}
(await options.rebind(CloudTasksClientProvider)).to(KeepaliveCloudTasks).inSingletonScope();
```

Unbound, it is `new CloudTasksClient()` — nobody has to bind anything. (A provider class rather than
an optional `CloudTasksClient` binding, because the app container's inversify `autobind` tries to
construct any unbound class token, `@optional()` included, and fails on `CloudTasksClient`.)

```ts
// you own timing AND retries (gax retries UNAVAILABLE); raise the safety cap
await scheduler.addToQueue(() => api.sendEmail(req),
    new ScheduleOptions(TaskName.dedup(id), undefined, undefined, { timeout: 10_000, retry: { retryCodes: [14] } }));
CallRegistry.setTimeout(60_000, EmailApi);

// process-wide defaults, no call-site edits
GcpTaskRegistry.setCustomizer((request) => { request.task!.dispatchDeadline = { seconds: 900 }; return request; }, 'ALL');
CallRegistry.setStrategy(new RetryStrategy(2_000, 5, 200, 2, 2_000).run, WhatsAppProcessApi);  // tune OUR retries
```

`createTask`'s public promise exposes no `cancel()`; on the default path the gRPC deadline equals the
attempt deadline, so gRPC cancels a hung RPC itself. See [client timeouts](../../../docs/client-timeouts.md).
`GcpTaskInvoker.grpc.spec.ts` proves all of it against a local fake gRPC server with the real
`CloudTasksClient`.
