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
    WRITE,
    WpAuthorization,
    WpAuthPublic,
} from '@webpieces/core-util';

/** Which thing to make. Used by ONE operation, so it is inlined there (#1303). */
export class MakeThingRequest {
    /** The new thing's name. */
    name!: string;
}

/** A ping. It carries nothing, and still inlines with an empty `properties`. */
export class PingRequest {}

/** The answer to a ping. */
export class PingResponse {
    /** When the ping was answered. @format date-time */
    answeredAt!: string;
}

/** What every write returns. Two operations share it, so it stays a component. */
export class SharedReply {
    /** The written thing's identifier. */
    id!: string;
}

/** A note to file. Also a field of the filed-note response, so it stays a component. */
export class NoteRequest {
    /** The note's text. */
    text!: string;
}

/** The note as filed. Used by ONE operation, so it is inlined there. */
export class FiledNoteResponse {
    /** The note that was filed. */
    note!: NoteRequest;
}

/** What an audit covers. */
export class AuditRequest {
    /** How many days back. */
    days!: number;
}

/** Things, for the wrapper-inlining fixture. */
@ApiPath('/things')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class WrappersApi {
    /**
     * Makes a thing.
     *
     * @summary Make a thing
     * @returns The made thing's identifier.
     */
    @Endpoint(POST, '/make', WRITE, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    make(request: MakeThingRequest): Promise<SharedReply> {
        throw new Error('contract');
    }

    /**
     * Checks the service is up.
     *
     * @summary Ping
     * @returns When the ping was answered.
     */
    @Endpoint(POST, '/ping', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    ping(request: PingRequest): Promise<PingResponse> {
        throw new Error('contract');
    }

    /**
     * Files a note.
     *
     * @summary File a note
     * @returns The note as filed.
     */
    @Endpoint(POST, '/note', WRITE, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    note(request: NoteRequest): Promise<FiledNoteResponse> {
        throw new Error('contract');
    }

    /**
     * Audits recent writes. Hidden from customers, yet it still SHARES the write reply with `make`:
     * single use is counted over every operation of the manifest, not per document.
     *
     * @summary Audit writes
     * @returns The audit's identifier.
     */
    @Endpoint(POST, '/audit', READ, RPC, { hidden: true })
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    audit(request: AuditRequest): Promise<SharedReply> {
        throw new Error('contract');
    }
}
