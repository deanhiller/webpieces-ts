import { injectable } from 'inversify';
import { NotController } from '@webpieces/http-routing';
import { Server2Api, FetchValueRequest, FetchValueResponse } from './Server2Client';

/**
 * Simulator for remote service.
 * Similar to Java Server2Simulator.
 *
 * This is used in production when you don't have a real remote service.
 * In tests, you'd use a mock implementation.
 *
 * @NotController: implements the Server2Api contract but is a simulator, not a routed controller.
 */
@injectable()
@NotController()
export class Server2Simulator extends Server2Api {
    override async fetchValue(request: FetchValueRequest): Promise<FetchValueResponse> {
        return {
            value: `Simulated response for: ${request.name}`,
            timestamp: Date.now(),
        };
    }
}
