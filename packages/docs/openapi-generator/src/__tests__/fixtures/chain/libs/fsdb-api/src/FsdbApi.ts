import { WpAuthorization, AuthorizationType } from '@webpieces/core-util';
/* eslint-disable */
import {
    ApiPath,
    ApiType,
    Endpoint,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthPublic,
    WpMcpTool,
} from '@webpieces/core-util';
import { PassageItemDto } from '@fixture/dtos-a';

/** Descriptions as stored — fsdb-api's OWN type of this name, a third shape. */
export interface LocalizedDescriptionsDto {
    /** The storage key. */
    key: string;
}

/** A stored passage lookup. */
export interface StoredPassageRequest {
    /** The passage's identifier. */
    passageId: string;
}

/** A stored passage. */
export interface StoredPassageResponse {
    /** The passage, exactly as lang-apis publishes it. */
    passage: PassageItemDto;
    /** Where its descriptions are stored. */
    descriptions: LocalizedDescriptionsDto;
}

/** Storage. */
@ApiPath('/fsdb')
@ApiType(SVC_TO_SVC, MCP)
export class FsdbApi {
    /** Reads one stored passage. */
    @Endpoint(POST, '/passage', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('read_passage')
    readPassage(request: StoredPassageRequest): Promise<StoredPassageResponse> {
        throw new Error('contract');
    }
}
