/**
 * WHO is receiving an error: the one fact {@link ReceivedApiErrorRule} cannot read off the wire.
 *
 * Every client declares it at SETUP, explicitly, and there is no default (issue #1173): a node
 * `ClientConfig`, a browser `ClientConfig`, an `IpcClientFactory`. It decides exactly one thing today,
 * what a received **401 Unauthorized** means, and the two answers have opposite owners:
 *
 * - {@link ClientRole.END_USER_CLIENT} — a browser bundle, an Expo shell, a remote MCP client. The
 *   credential it presented IS the user's session, so a 401 means "log in again": it is decoded as
 *   `ApiUnauthorizedError`, the type the app's re-login path catches.
 * - {@link ClientRole.SERVER} — a server calling another server. The credential it presented is ITS
 *   OWN (a service token, a shared secret), so a 401 is this service's credential or configuration
 *   bug: `ApiImplementationError`, a 500 to its own caller. Relaying the 401 would tell the browser
 *   "your session expired", log the user out for a backend misconfiguration, and stop paging the team
 *   that owns the broken credential.
 *
 * A server that rejects the INCOMING user's token throws `ApiUnauthorizedError` itself; that is a 401
 * it ORIGINATES, and the end-user client then decodes it typed.
 *
 * Why no default: the safe-looking choice is different for each half of the estate (SERVER is right
 * for a backend, wrong for a browser), so any default would be silently wrong for one of them. Stating
 * it costs one argument at each client's setup.
 */
export enum ClientRole {
    END_USER_CLIENT = 'end-user-client',
    SERVER = 'server',
}
