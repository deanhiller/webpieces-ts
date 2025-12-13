import { injectable } from 'inversify';
import { Controller, provideSingleton, ValidateImplementation } from '@webpieces/http-routing';
import { PublicApi, PublicInfoRequest, PublicInfoResponse } from '@webpieces/example-apis';

/**
 * PublicController - Extends PublicApiPrototype and implements PublicApi.
 *
 * A simple controller for public endpoints that don't require authentication.
 * Used to demonstrate a second API endpoint for testing.
 */
@provideSingleton()
@Controller()
export class PublicController implements PublicApi {

    async getInfo(request: PublicInfoRequest): Promise<PublicInfoResponse> {
        return {
            greeting: `Hello, ${request.name ?? 'World'}!`,
            serverTime: new Date().toISOString(),
            name: request.name,
        };
    }
}
