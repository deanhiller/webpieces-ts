/* eslint-disable */
/**
 * A contract declaring NO `@ApiType`, so it feeds the internal document ALONE.
 *
 * It is here to pin the fail-closed default from the other side: a manifest listing only this
 * contract writes `full-private-openapi` and nothing else, because a document nobody asked for is
 * not written empty — it is not written.
 */
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic } from '@webpieces/core-util';

export interface HeartbeatRequest {
    at: string;
}

/** Plumbing. */
@ApiPath('/internal')
export class InternalOnlyApi {
    /** Says nothing about who may read it, so the default decides. */
    @Endpoint(POST, '/heartbeat', READ, RPC)
    @WpAuthPublic('Fixture only.')
    heartbeat(request: HeartbeatRequest): Promise<void> {
        throw new Error('contract');
    }
}
