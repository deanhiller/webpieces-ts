# Portable IPC server

`IpcServerFactory` registers explicit shared contracts and already-constructed implementations. It does not create a bus or import an HTTP server, DI container, React Native runtime or Node request context.

```typescript
const server = new IpcServerFactory(logging);
server.create(playbackContract, new NativePlaybackController(player));
server.create(navigationContract, new NavigationController(router));
connection.setHandler(server.handle); // exactly once, before sending any calls
```

One connection has one dispatcher containing multiple APIs. Duplicate registrations fail. Unknown API/method IDs return canonical `EndpointNotFoundError`, distinct from a missing domain entity. Schemas validate both request and reply; successful void is encoded explicitly as null. Receiver exceptions are logged then encoded with the same `ApiErrorCodec` used by the sender to reconstruct canonical errors.

`createScoped(contract, scope)` accepts an `IpcControllerScope<T>` whose `create(context)` supplies the implementation for that invocation. Inject a `clients.withContext(context)` proxy into this controller when it calls back or invokes another API. Concurrent calls have separate context objects and do not overwrite a global async context.

A host may register receivers and create client proxies on both ends of the same connection. `IpcConnection` owns transport parse/send failures and disposal; see the IPC client README for the transport and logging contracts, error ownership, security responsibilities and downstream native lifecycle tests.
