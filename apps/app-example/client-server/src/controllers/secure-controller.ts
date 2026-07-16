import { injectable, bindingScopeValues } from 'inversify';
import { WebpiecesCoreHeaders } from '@webpieces/core-util';
import { DocumentDesign } from '@webpieces/http-routing';
import { RequestContext } from '@webpieces/core-context';
import { SecureApi, SecureRequest, SecureResponse } from '@webpieces/client-server-api';

/**
 * SecureController - implements {@link SecureApi}. Each method just returns ok (+ the userId the
 * framework stamped from the JWT for the admin op), so Authentication.spec.ts can assert the
 * AuthMode was enforced and the parsed context landed.
 */
@injectable(bindingScopeValues.Singleton)
@DocumentDesign()
export class SecureController extends SecureApi {
    override async userOp(_request: SecureRequest): Promise<SecureResponse> {
        return { ok: true, userId: RequestContext.getHeader<string>(WebpiecesCoreHeaders.USER_ID) };
    }

    override async adminOp(_request: SecureRequest): Promise<SecureResponse> {
        return { ok: true, userId: RequestContext.getHeader<string>(WebpiecesCoreHeaders.USER_ID) };
    }

    override async orgOp(_request: SecureRequest): Promise<SecureResponse> {
        return { ok: true, userId: RequestContext.getHeader<string>(WebpiecesCoreHeaders.USER_ID) };
    }

    override async internalOp(_request: SecureRequest): Promise<SecureResponse> {
        return { ok: true };
    }

    override async serviceOp(_request: SecureRequest): Promise<SecureResponse> {
        return { ok: true };
    }
}
