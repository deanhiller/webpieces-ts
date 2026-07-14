# @webpieces/cloudtasks-client

The Cloud Tasks twin of `@webpieces/http-client`. A `@PubSub` API contract is shared
by the enqueue client and the controller, exactly like RPC — calling a method on the
client **enqueues a Cloud Task** that is later delivered (POST) to the SAME endpoint,
where it runs through the full server filter chain.

```ts
// one shared contract
@PubSub() @AuthOidc() @ApiPath('/email')
abstract class EmailApi { @Endpoint('/send') sendEmail(r: SendEmailRequest): Promise<void> {…} }

// build the client once (sync); 'email-svc' is the callee's Cloud Run service name
const emailTasks = factory.createPubSubClient(EmailApi, new TaskClientConfig('email-svc'));
// ...or pin a URL lookup cannot describe (other region/project); svcName stays the log name
const other = factory.createPubSubClient(EmailApi, new TaskClientConfig('email-svc', 'https://email.eu.example'));

// producer (inside a request → RequestContext active)
await scheduler.addToQueue(() => emailTasks.sendEmail(req), { dedupName: req.id });
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
- `TaskInvoker` (abstract token) with two impls:
  - `GcpTaskInvoker` — real `@google-cloud/tasks` delivery (OIDC / shared-secret)
  - `InMemoryTaskInvoker` — dispatches through the real server filter chain in-process
    (tests + local dev, no GCP, production parity)
