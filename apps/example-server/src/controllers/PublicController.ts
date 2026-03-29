import { Controller, provideSingleton } from '@webpieces/http-routing';
import { PublicInfoRequest, PublicInfoResponse } from '@webpieces/example-apis';

/**
 * PublicController - Implements PublicApi.
 *
 * A simple controller for public endpoints that don't require authentication.
 * Used to demonstrate a second API endpoint for testing.
 */
@provideSingleton()
@Controller()
export class PublicController {

    async getInfo(request: PublicInfoRequest): Promise<PublicInfoResponse> {
        return {
            greeting: `Hello, ${request.name ?? 'World'}!`,
            serverTime: new Date().toISOString(),
            name: request.name,
        };
    }
}
