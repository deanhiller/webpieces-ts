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
import { LessonScopedDto, PassageItemDto } from '@fixture/dtos-a';
import { LocalizedDescriptionsDto as SharedDescriptionsDto, SpeakerGenderDto } from '@fixture/dtos-b';
import { LocalizedDescriptionsDto } from './LocalizedDescriptionsDto';

/** A request for one lesson's passages. Its base lives in ANOTHER package, and is flattened. */
export interface PassageListRequest extends LessonScopedDto {
    /** Only passages narrated as this gender. */
    narrator?: SpeakerGenderDto;
}

/** One lesson's passages. */
export interface PassageListResponse {
    /** Every passage, in reading order. */
    passages: PassageItemDto[];
    /** This library's own descriptions of the lesson. */
    descriptions: LocalizedDescriptionsDto;
    /** The shared, per-language descriptions — a DIFFERENT type with the same name. */
    translations: SharedDescriptionsDto;
}

/** Lessons. */
@ApiPath('/lang')
@ApiType(SVC_TO_SVC, MCP)
export class LangLessonApi {
    /** Lists a lesson's passages. */
    @Endpoint(POST, '/passages', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('list_passages', 'List passages')
    listPassages(request: PassageListRequest): Promise<PassageListResponse> {
        throw new Error('contract');
    }
}
