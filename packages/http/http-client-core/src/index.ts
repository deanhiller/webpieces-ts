/**
 * @webpieces/http-client-core
 *
 * The ISOMORPHIC core of the webpieces HTTP client — everything that reads an API contract's
 * decorators and turns a method call into an HTTP request, with no opinion about where the
 * magic context comes from or whether a DI container exists.
 *
 * You almost certainly want one of its two environment packages instead:
 * - Server:  @webpieces/http-client-node    (inversify-wired, reads RequestContext, mints OIDC)
 * - Browser: @webpieces/http-client-browser (no DI — React or Angular, app-managed context store)
 *
 * Architecture:
 * ```
 * http-api (defines the contract)
 *    ^
 *    +-- http-routing (server: contract -> handlers)
 *    +-- http-client-core (contract -> HTTP requests)   <- YOU ARE HERE
 *          +-- http-client-node     (RequestContext + Secrets + OIDC + inversify factory)
 *          +-- http-client-browser  (app-held store + plain factory, no DI)
 * ```
 *
 * There is no context/credential/recording seam here at all: ProxyClient is ABSTRACT and asks its
 * subclass for the base URL, the context headers, the log map, the outbound credential, and the
 * recorder. Nothing server-only (RequestContext, Secrets, mintIdToken, TestCaseRecorder) can reach
 * a browser bundle, and nothing browser-only (a ContextReader store) reaches a server.
 */

export { ProxyClient } from './ProxyClient';
export { RequestOutcome } from './RequestOutcome';
export type { ApiPrototype } from './ApiPrototype';
export { buildClientProxy } from './buildClientProxy';
export { ClientErrorTranslator } from './ClientErrorTranslator';
// The CLIENT-side transport boundary: a fetch Response becomes the ONE HttpResponseDto an app's
// ErrorTranslator sees, so node and browser hand `fromWire` the identical shape.
export { HttpResponseDtoFactory } from './HttpResponseDtoFactory';
export { RequestBodySerializer } from './RequestBodySerializer';
export { ResponseBodyReader } from './ResponseBodyReader';
// The OUTBOUND filter chain: the mutable request a filter edits, and one registration of a filter
// at a priority. The `Filter`/`Service`/`FilterChain` abstraction itself lives in
// @webpieces/core-util, shared with the server's inbound chain.
export { ClientRequest } from './ClientRequest';
export { ClientFilterDefinition } from './ClientFilter';
export type { ClientFilter } from './ClientFilter';
// Generic streaming wire adapters: NDJSON uploads, request-scoped SSE downloads, and a typed
// capability failure for runtimes that cannot safely keep both fetch halves open concurrently.
export { NdjsonRequestStream } from './NdjsonRequestStream';
export { SseEvent, SseEventParser } from './SseEventParser';
export { SseResponseStream } from './SseResponseStream';
export { StreamEnvelopeCodec } from './StreamEnvelopeCodec';
export { StreamingCapabilityError } from './StreamingCapabilityError';
export { Utf8Codec } from './Utf8Codec';
export type { ByteReadableStream, ByteStreamReader, ByteReadResult } from './ByteStream';
