# @webpieces/http-server

> WebPieces server with filter chain and dependency injection

Part of the [WebPieces TypeScript](https://github.com/deanhiller/webpieces-ts) framework.

## Features

- 🎯 Built on Express.js with enhanced capabilities
- 🔗 Filter chain architecture for request/response processing
- 💉 Integrated dependency injection with InversifyJS
- 🚀 Request-scoped context management
- ✨ Type-safe routing and middleware

## Installation

```bash
npm install @webpieces/http-server
```

## Request bodies on hosts that parse first

webpieces reads each request body itself, straight off the request stream (`StreamBodyReader`, the
default). Some hosts read that stream before your app runs. Cloud Functions gen2 and Firebase are two
of them: they keep the original bytes on `req.rawBody`. Reading an already-consumed stream would wait
forever, so the default reader fails the request immediately with a message naming the fix. On such
hosts, opt in before binding the routes:

```typescript
const router = new WebpiecesExpressRouter(apiFactory);
router.setBodyReader(new PreConsumedBodyReader());
router.bindExpress(app);
```

`PreConsumedBodyReader` uses `req.rawBody` (the exact bytes sent, so `{ rawBody: true }` webhook
signatures still verify). If the stream was not consumed, it reads the stream as usual. If the stream
was consumed and there is no `req.rawBody`, it fails fast. It never re-serializes `req.body`. If you
mount your own body parser ahead of webpieces, either mount webpieces first or keep the bytes with
`express.json({ verify: (req, _res, buf) => { req.rawBody = buf; } })`.

## End-user errors on a partner-facing API edge

An `ApiEndUserError` is answered with **266** by default: the call succeeded and a GUI (or the next
webpieces hop) shows its message. A partner or public REST API whose contract promises real 4xx
statuses opts its router into edge mode before binding the routes:

```typescript
const router = new WebpiecesExpressRouter(apiFactory);
router.setEndUserStatus('edge');
router.bindExpress(app);
```

The response then carries the status the throw site chose,
`new ApiEndUserError(message, errorCode, edgeHttpStatus, cause)` with `edgeHttpStatus` one of
400/404/409/422, or 400 when it chose none. That field travels in the error body across every
server-to-server hop, so a service several hops down can set it. Keep internal servers and GUI
backends in the default `'gui'` mode: a webpieces client only accepts an end-user error at 266, and a
real 4xx on a hop is still that caller's own 500.

## Documentation

See the main [WebPieces README](https://github.com/deanhiller/webpieces-ts#readme) for complete documentation and examples.

## License

Apache-2.0
