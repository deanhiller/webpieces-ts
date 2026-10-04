import { WpAuthorization, AuthorizationType, WpAuth, jwt as jwtAuth } from '@webpieces/core-util';
import { ApiPath, ApiType, Endpoint, MCP, POST, READ, RPC, WpMcpTool } from '@webpieces/core-util';
import { LearnerNamedDto } from '@fixture/source-dtos';
import { AiProvider, OfflineSettingsDto } from '@fixture/published-dtos';
import { LessonScriptRequest } from './LessonBases';

/**
 * INHERITED FIELDS (#1055). A DTO's wire document is every field it has, including the ones it gets
 * through `extends` — from a base in another file, a base in another package read as SOURCE through
 * tsconfig paths, and a base in a PUBLISHED package read from its `.d.ts`.
 */

/** Asks for a lesson's audio. ONE level below the cross-file base. */
export class LessonAudioRequest extends LessonScriptRequest {
    /** Refresh reusable word and syllable clips before rebuilding existing lesson audio. */
    regenerate?: boolean;
}

/** Asks for a lesson render. TWO levels below the base, and it OVERRIDES one inherited field. */
export class LessonRenderRequest extends LessonAudioRequest {
    /** The voice to render with — REQUIRED here, where the base left it optional. */
    override voice!: string;

    /** Output formats, as a readonly array. */
    formats!: readonly string[];

    /** Free-form labels, as a ReadonlyArray. */
    labels?: ReadonlyArray<string>;
}

/** The lang consumer's case: a response extending a class from a published package. */
export class MySettingsResponse extends OfflineSettingsDto {
    /** The AI providers this learner has connected. */
    connectedAiProviders!: readonly AiProvider[];
}

/** Something with an age. */
export interface AgedDto {
    /** Age in years, when known. */
    age?: number;
}

/** A learner lookup: an interface extending TWO bases, one from another package. */
export interface LearnerLookupRequest extends LearnerNamedDto, AgedDto {
    /** Age in years — REQUIRED for a lookup, where AgedDto left it optional. */
    age: number;

    /** Whether to include archived learners. */
    includeArchived?: boolean;
}

/** Lessons, for the inheritance tests. */
@ApiType(MCP)
@ApiPath('/lessons')
export abstract class InheritanceApi {
    /** Renders one lesson. */
    @WpMcpTool('render_lesson')
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })

    @Endpoint(POST, '/render', READ, RPC)
    render(_request: LessonRenderRequest): Promise<MySettingsResponse> {
        throw new Error('contract only');
    }

    /** Looks one learner up. */
    @WpMcpTool('lookup_learner')
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })

    @Endpoint(POST, '/lookup', READ, RPC)
    lookup(_request: LearnerLookupRequest): Promise<LessonAudioRequest> {
        throw new Error('contract only');
    }
}
