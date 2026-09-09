# Portable IPC client

`@webpieces/ipc-client` creates typed API proxies for browser, React Native and Node. The host supplies one trusted JSON transport connection. `@webpieces/ipc-server` dispatches the other side. Either side can be both client and server.

Declare a shared abstract API and an `IpcContract` from `@webpieces/core-util/ipc` beside it. Its `IpcMethods<Api>` mapping requires one `IpcMethod` per API member. Each method declares an explicit stable wire ID, request schema, response schema, masking spec and request/notification kind. Schemas implement `parse(unknown)` and validate/reconstruct a DTO. Methods accept exactly one non-null DTO and return a Promise. Use `IpcVoidSchema` for acknowledged void. Notifications also acknowledge failures; they never silently swallow them.

```typescript
abstract class PlaybackApi {
    abstract play(request: PlayRequest): Promise<void>;
}
class PlaybackMethods {
    readonly play = new IpcMethod('play.v1', new PlayRequestSchema(), new IpcVoidSchema(), new MaskSpec({}));
}
const playbackContract = new IpcContract('playback.v1', PlaybackApi, new PlaybackMethods());
const clients = new IpcClientFactory(connection, logging);
const playback = clients.createClient(playbackContract);
await playback.play(new PlayRequest('track-id'));
```

The schema, DTO, IDs and metadata live in the shared contract package. The names of the abstract class and controller are never sent on the wire. Proxy inspection, symbols and `then` do not send requests.

Construct `IpcConnection` with an `IpcTransport` adapter and `IpcConnectionOptions`: a positive timeout, a connection-wide unique ID generator, a scheduler returning timer cancellation functions, and an error owner. The adapter sends strings and subscribes once to incoming strings, transport errors and close events. Its send Promise must reject on send failure; parse/message-error callbacks go to the failure subscriber. A vendor bus adapter must not expose vendor Node declarations through its public contract. Do not install a second vendor handler for every API.

`IpcLogging.context(call)` is required and supplies an active per-call `ApiCallContext` carrying the transaction/call/parent IDs in the host logger. Both factories invoke framework `LogApiCallImpl`; receiver logging happens before encoding failures and sender completion logging happens after decoding. `UserError` is rethrown but remains a successful monitoring outcome. Configure the normal framework logging backend at bootstrap. Masking affects logs, never wire DTOs.

Use `clients.withContext(inboundContext)` when making nested calls; this copies the transaction and makes the inbound call the parent. No ambient mutable state is held across awaits. `createScoped` on the server supports constructing a controller with a scoped client factory.

Timeout rejects with the existing `TimeoutError`. Send/close/disposal rejects with local `IpcTransportError`, preserving the original failure as standard `cause`. This extends `Error`, not semantic `ApiError`, and is never a remote wire category. A receiver throwing `ServiceUnavailableError` still arrives as that canonical semantic error, so callers can distinguish a failed local bridge from an unavailable remote implementation. A timeout does not cancel remote side effects, and the framework never replays requests. `dispose()` rejects pending requests and closes the adapter. Late replies are reported and ignored. Malformed envelopes and correlation mismatches fail the connection, including its pending calls. Observe all OS-callback send Promises or route rejections to the application's explicit error owner.

Host responsibilities: validate WebView origins/navigation/session identity and expose only authorized APIs. Suspension/resume, coalescing native state, durable usage journals and installed shell protocol minimums are application policies. Generic IPC cannot make suspended website JavaScript execute. Android/iOS lifecycle and locked-screen tests remain downstream integration work.

The required compatibility build checks published declarations without Node/DOM ambient types, scans transitive runtime dependencies, bundles Android/iOS with Metro and compiles Hermes bytecode. Hermes/device execution is a separate verification claim and must only be made when actually run.
