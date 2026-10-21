import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
/* eslint-disable */
/**
 * PUT / PATCH / DELETE with `@PathParam` and `@QueryParam` arguments (#1339): the request body is the
 * ONE argument with no URL binding, and every bound argument is an OpenAPI `parameters` entry.
 */
import {
    ApiPath,
    DELETE,
    Endpoint,
    GET,
    NONE,
    PATCH,
    PathParam,
    PUT,
    QueryParam,
    READ,
    RPC,
    WpAuthPublic,
    WRITE,
    WRITE_IDEMPOTENT,
} from '@webpieces/core-util';

/** The new state of a gadget. */
export interface ReplaceGadgetRequest {
    /** Its display name. */
    name: string;
}

/** A gadget. */
export interface GadgetDto {
    /** Its identifier. */
    id: string;
}

/** Gadgets, addressed REST-style. */
@ApiPath('/gadgets')
export class RestVerbsApi {
    /**
     * Finds gadgets.
     *
     * @summary Find gadgets
     * @returns The first matching gadget.
     */
    @Endpoint(GET, '/{shopId}', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    find(
        @PathParam('shopId') shopId: string,
        @QueryParam('limit') limit?: number,
        @QueryParam('tag') tags?: string[],
    ): Promise<GadgetDto> {
        throw new Error('contract');
    }

    /**
     * Replaces one gadget.
     *
     * @summary Replace a gadget
     * @returns The replaced gadget.
     */
    @Endpoint(PUT, '/{shopId}/{gadgetId}', WRITE_IDEMPOTENT, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    replace(
        @PathParam('shopId') shopId: string,
        @PathParam('gadgetId') gadgetId: string,
        request: ReplaceGadgetRequest,
    ): Promise<GadgetDto> {
        throw new Error('contract');
    }

    /**
     * Renames one gadget.
     *
     * @summary Rename a gadget
     * @returns The renamed gadget.
     */
    @Endpoint(PATCH, '/{shopId}/{gadgetId}', WRITE, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    rename(
        @PathParam('shopId') shopId: string,
        @PathParam('gadgetId') gadgetId: string,
        request: ReplaceGadgetRequest,
    ): Promise<GadgetDto> {
        throw new Error('contract');
    }

    /**
     * Deletes one gadget.
     *
     * @summary Delete a gadget
     * @returns The deleted gadget.
     */
    @Endpoint(DELETE, '/{shopId}/{gadgetId}', WRITE_IDEMPOTENT, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    remove(
        @PathParam('shopId') shopId: string,
        @PathParam('gadgetId') gadgetId: string,
    ): Promise<GadgetDto> {
        throw new Error('contract');
    }

    /**
     * Marks one gadget as seen.
     *
     * @summary Touch a gadget
     */
    @Endpoint(PUT, '/{shopId}/{gadgetId}/touch', WRITE_IDEMPOTENT, RPC, { responseBody: NONE })
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    touch(
        @PathParam('shopId') shopId: string,
        @PathParam('gadgetId') gadgetId: string,
    ): Promise<void> {
        throw new Error('contract');
    }
}
