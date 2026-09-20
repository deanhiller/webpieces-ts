import { ApiErrorPayload } from '../errors/ApiErrorCodec';
import { IpcReply } from './IpcProtocol';

/**
 * IpcErrorTranslator - ONE symmetric place an app owns IPC error translation, in BOTH directions.
 *
 * The exact twin of `ErrorTranslator` for HTTP, down to the shape of each half: `toWire` is called in
 * a catch and RETURNS the payload the reply carries, `fromWire` is its mirror and THROWS. It exists
 * for the same reason: IPC already HAD both halves, hand-rolled at three call sites
 * (`IpcServerFactory.handle`, `IpcConnection.dispatch`, `IpcClientFactory`), with no seam an app could
 * reach. An app whose two processes share an error taxonomy had nowhere to put it.
 *
 * Register one with {@link IpcRegistry.setErrorTranslator} — one registry per PROTOCOL, mirroring
 * `ClientRegistry` for HTTP and `McpRegistry` for MCP, because the three speak different wire shapes
 * and an app rarely wants the same answer on all three.
 *
 * There is ALWAYS a translator ({@link IpcRegistry.getErrorTranslator} is non-optional), so every call
 * site is one unconditional line and a registered translator declines by DELEGATING to
 * {@link WebpiecesDefaultIpcErrorTranslator}.
 *
 * This is a business-logic contract (methods, not data), so it is an interface per the webpieces
 * guidelines.
 */
export interface IpcErrorTranslator {
    /**
     * SERVER: exception -> the wire payload carried by `IpcFailure`. Always a payload; decline by
     * returning `new WebpiecesDefaultIpcErrorTranslator().toWire(error)`, which applies the shared
     * `ApiErrorBoundary` publication rule (notably: a caller-local `ApiConnectionError` publishes as
     * `implementation`, because to the PEER this process is what is broken).
     */
    toWire(error: Error): ApiErrorPayload;

    /**
     * CLIENT: the reply -> a THROW. Called for EVERY reply, success or failure, exactly as on the
     * HTTP side, so an app can turn a "successful" reply into a throw. Returning normally means "let
     * this reply through"; the webpieces default returns for an `IpcSuccess` and throws for an
     * `IpcFailure`. Decline by calling
     * `new WebpiecesDefaultIpcErrorTranslator().fromWire(reply)`.
     */
    fromWire(reply: IpcReply): void;
}
