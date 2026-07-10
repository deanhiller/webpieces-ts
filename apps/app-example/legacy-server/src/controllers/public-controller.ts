import { DocumentDesign, provideSingleton } from '@webpieces/http-routing';
import { PublicApi, PublicInfoRequest, PublicInfoResponse } from '@webpieces/client-server-api';

/**
 * PublicController - implements PublicApi (public, no-auth endpoint). Copied into
 * legacy-server so the legacy app is self-contained.
 */
@provideSingleton()
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
