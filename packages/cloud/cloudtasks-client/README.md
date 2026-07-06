# @webpieces/cloudtasks-client

The Cloud Tasks twin of `@webpieces/http-client`. A `@PubSub` API contract is shared
by the enqueue client and the controller, exactly like RPC — calling a method on the
client **enqueues a Cloud Task** that is later delivered (POST) to the SAME endpoint,
where it runs through the full server filter chain.

```ts
// one shared contract
@PubSub() @AuthOidc() @ApiPath('/email')
abstract class EmailApi { @Endpoint('/send') sendEmail(r: SendEmailRequest): Promise<void> {…} }

// producer (inside a request → RequestContext active)
await scheduler.addToQueue(() => emailTasks.sendEmail(req), { dedupName: req.id });
```

- `createTaskClient(Api, TaskClientConfig)` / `TaskClientCreator` — the enqueue proxy
- `CloudTaskScheduler` — `addToQueue` / `schedule` / `cancelJob`; carries scheduling
  options out-of-band so the contract signature stays identical on both sides
- `TaskInvoker` (abstract token) with two impls:
  - `GcpTaskInvoker` — real `@google-cloud/tasks` delivery (OIDC / shared-secret)
  - `InMemoryTaskInvoker` — dispatches through the real server filter chain in-process
    (tests + local dev, no GCP, production parity)
