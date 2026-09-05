import { injectable, bindingScopeValues } from 'inversify';
import { DocumentDesign } from '@webpieces/http-routing';
import { PublicApi, PublicInfoRequest, PublicInfoResponse } from '@webpieces/client-server-api';

/**
 * PublicController - Implements PublicApi.
 *
 * A simple controller for public endpoints that don't require authentication.
 * Used to demonstrate a second API endpoint for testing.
 */
@injectable(bindingScopeValues.Singleton)
@DocumentDesign()
export class PublicController extends PublicApi {

    override async getInfo(request: PublicInfoRequest): Promise<PublicInfoResponse> {
        return {
            greeting: `Hello, ${request.name ?? 'World'}!`,
            serverTime: new Date().toISOString(),
            name: request.name,
        };
    }
}
