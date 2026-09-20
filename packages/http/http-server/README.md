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

## End-user errors, and the caller SURFACE that decides their status

An `ApiEndUserError` is answered with **266** by default: the call succeeded and a GUI (or the next
webpieces hop) shows its message.

A partner or public REST API whose contract promises real 4xx statuses gets them **per request**, not
per router. The same endpoint is reached by a browser GUI, by an LLM through the MCP bridge and by an
external partner, so which one it is was never something a router could know. `AuthFilter` stamps
`WebpiecesCoreHeaders.SURFACE` from the auth mode that matched, and `ExpressWrapper.handleError`
derives the status from it (`SurfaceEndUserStatus`):

| how the request authenticated | surface | an `ApiEndUserError` answers |
|---|---|---|
| `@WpAuthJwt` | `gui` | 266 |
| `@WpMcpAuthJwt` (through the MCP bridge) | `llm` | 266 |
| `@WpAuthApiKey` | `public-api` | `edgeHttpStatus`, else 400 |
| nothing established one (public, webhook, internal hop) | absent | 266 |

`gui` and `llm` are both webpieces clients that DECODE the body and render the message themselves, so
a real 4xx would throw away the only thing they are there to show. A partner has no such client.

The published status is the one the throw site chose:
`new ApiEndUserError(message, errorCode, edgeHttpStatus, cause)` with `edgeHttpStatus` one of
400/404/409/422, or 400 when it chose none. That field travels in the error body across every
server-to-server hop, so a service several hops down can set it — and the SURFACE travels with it, so
the hop that finally answers the partner still knows who asked.

## Documentation

See the main [WebPieces README](https://github.com/deanhiller/webpieces-ts#readme) for complete documentation and examples.

## License

Apache-2.0
