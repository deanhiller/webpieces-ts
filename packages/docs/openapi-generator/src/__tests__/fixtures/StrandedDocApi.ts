/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
} from '@webpieces/core-util';

/** One publication — one internal publish job and its per-store outcomes. */
/** The overall state of one publication. */
export enum MenuPublicationStatusDto {
    PENDING = 'pending',
    DONE = 'done',
}

export class MenuPublicationDto {
    /** Stranded from a field that was deleted. */
    /** The publication's id. */
    id!: string;

    /** Where the publication is. */
    status!: MenuPublicationStatusDto;
}

/** Which publication to read. */
export class GetPublicationRequest {
    /** The publication's id. */
    id!: string;
}

/** Menu publications. */
@ApiPath('/publications')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class StrandedDocApi {
    /** A doc for a method that no longer exists. */
    /**
     * Reads one publication.
     *
     * @summary Read a publication
     */
    @Endpoint(POST, '/get', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    get(request: GetPublicationRequest): Promise<MenuPublicationDto> {
        throw new Error('contract');
    }
}
