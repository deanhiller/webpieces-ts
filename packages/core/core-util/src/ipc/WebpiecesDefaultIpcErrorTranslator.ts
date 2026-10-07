import { ApiErrorBoundary } from '../errors/ApiErrorBoundary';
import { ApiErrorCodec, ApiErrorPayload } from '../errors/ApiErrorCodec';
import { ApiCodedError } from '../errors/ApiError';
import { ClientRole } from '../errors/ClientRole';
import { ReceivedApiErrorRule } from '../errors/ReceivedApiErrorRule';
import { ApiErrorHttpStatus } from '../http/ApiErrorHttpStatus';
import { IpcErrorTranslator } from './IpcErrorTranslator';
import { IpcReply } from './IpcProtocol';

/**
 * THE webpieces default {@link IpcErrorTranslator}, and what {@link IpcRegistry} holds until an app
 * installs its own.
 *
 * `toWire` is exactly what the two IPC receivers did inline before this seam existed — the shared
 * {@link ApiErrorBoundary}, so the `ApiConnectionError` -> `implementation` rule survives untouched.
 *
 * `fromWire` is a BEHAVIOUR CHANGE and a deliberate one. `IpcClientFactory` used to rethrow
 * `ApiErrorCodec.decode(reply.error)` verbatim, which handed the caller the PEER's error type as if
 * this process had produced it. IPC now applies the SAME {@link ReceivedApiErrorRule} as HTTP: a
 * caller-error kind coming back means I sent a bad IPC request (MY bug ->
 * `ApiImplementationError`), a server-side kind means the peer broke (NOT my bug ->
 * `ApiDependencyError`), an incoming `ApiDependencyError` is already attributed and rethrows as-is,
 * an `ApiEndUserError` is the actor's own answer and passes through (as its registered subclass), an
 * `ApiClientTooOldError` passes through on every hop, and an `unauthorized` reply depends on the
 * receiving {@link ClientRole}.
 *
 * The two protocols share ONE rule object rather than two copies for the obvious reason: an app that
 * moves a call from IPC to HTTP or back must not thereby change which team gets paged.
 */
export class WebpiecesDefaultIpcErrorTranslator implements IpcErrorTranslator {
    private readonly boundary = new ApiErrorBoundary();

    toWire(error: Error): ApiErrorPayload {
        return this.boundary.encode(error);
    }

    /** @param role - who is receiving, declared at `IpcClientFactory` setup. Decides what a 401 means. */
    fromWire(reply: IpcReply, role: ClientRole): void {
        if (reply.type === 'success') {
            return;
        }
        const decoded = ApiErrorCodec.decode(reply.error);
        // IPC has no wire status, so the equivalent is derived from the payload's own kind through
        // the ONE status table HTTP uses. Same table, same verdict, no second ladder to keep in step.
        const statusCode = decoded instanceof ApiCodedError ? decoded.statusCode : undefined;
        const equivalent = ApiErrorHttpStatus.hasCode(decoded)
            ? ApiErrorHttpStatus.codeFor(decoded.kind, statusCode)
            : 500;
        throw ReceivedApiErrorRule.adapt(role, equivalent, decoded.message, decoded);
    }
}

/** Process-wide built-in instance — stateless, so one shared instance is enough. */
export const WEBPIECES_DEFAULT_IPC_ERROR_TRANSLATOR = new WebpiecesDefaultIpcErrorTranslator();
