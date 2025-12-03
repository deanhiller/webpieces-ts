import { injectable } from 'inversify';
import { Controller, provideSingleton, ValidateImplementation } from '@webpieces/http-routing';
import { PublicApi, PublicInfoRequest, PublicInfoResponse } from '../api/PublicApi';

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
        const response = new PublicInfoResponse();
        response.greeting = `Hello, ${request.name ?? 'World'}!`;
        response.serverTime = new Date().toISOString();
        response.name = request.name;
        return response;
    }
}
