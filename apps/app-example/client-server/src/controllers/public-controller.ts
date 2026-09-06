import { injectable, bindingScopeValues } from 'inversify';
import { DocumentDesign } from '@webpieces/http-routing';
import { PublicApi, PublicInfoRequest, PublicInfoResponse } from '@webpieces/client-server-api';
import { OrderNotFoundError } from '../OrderErrors';

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
        // The app's OWN error type, thrown from ordinary controller code. `OrderErrorTranslators`
        // turns it into the app's own 460 envelope on the way out, and turns it
        // back into this exact type inside a calling client — see ErrorTranslationSymmetry.spec.ts.
        if (request.name === 'missing-order') {
            throw new OrderNotFoundError('order-4471');
        }

        return {
            greeting: `Hello, ${request.name ?? 'World'}!`,
            serverTime: new Date().toISOString(),
            name: request.name,
        };
    }
}
