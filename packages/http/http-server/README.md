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

## Documentation

See the main [WebPieces README](https://github.com/deanhiller/webpieces-ts#readme) for complete documentation and examples.

## License

Apache-2.0
