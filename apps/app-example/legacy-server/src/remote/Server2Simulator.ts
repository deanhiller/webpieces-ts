import { injectable } from 'inversify';
import { Server2Api, FetchValueRequest, FetchValueResponse } from './Server2Client';

/**
 * In-process simulator for the remote server2 service. Implements the Server2Api
 * contract but is a simulator, not a routed controller — the legacy-server test
 * rebinds Server2Api to this so it runs with no real server2 over HTTP.
 */
@injectable()
export class Server2Simulator extends Server2Api {
    override async fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        return {
            value: `Simulated response for: ${request.name}`,
            timestamp: Date.now(),
        };
    }
}
