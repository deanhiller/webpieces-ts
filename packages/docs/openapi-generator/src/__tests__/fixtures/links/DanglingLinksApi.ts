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

/** A type only the HIDDEN operation reaches, so the customer document never publishes it. */
export class AuditNoteDto {
    /** The note. */
    text!: string;
}

/** Which shelf. Names {@link NoSuchShelf}, which does not exist. */
export class ShelfRequestDto {
    /** The shelf's identifier. */
    shelfId!: string;
}

/** One shelf. */
export class ShelfResponseDto {
    /** The titles on it. */
    titles!: string[];
}

/** Asks for an audit. */
export class AuditRequestDto {
    /** What to write down. */
    note!: AuditNoteDto;
}

/** Shelves, linking to things a customer document does not publish (#1284). */
@ApiPath('/dangling')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class DanglingLinksApi {
    /**
     * Reads a shelf. Audits are written as {@link AuditNoteDto} by {@link DanglingLinksApi.audit}.
     *
     * @summary Read a shelf
     * @returns The shelf.
     */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    read(request: ShelfRequestDto): Promise<ShelfResponseDto> {
        throw new Error('contract');
    }

    /**
     * Audits a shelf. Internal only.
     *
     * @summary Audit a shelf
     * @returns The shelf.
     */
    @Endpoint(POST, '/audit', READ, RPC, { hidden: true })
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    audit(request: AuditRequestDto): Promise<ShelfResponseDto> {
        throw new Error('contract');
    }
}
