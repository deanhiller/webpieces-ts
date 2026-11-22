import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    JsonValueDto as SettingsJson,
    MCP,
    POST,
    RPC,
    WRITE,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    jwt as jwtAuth,
} from '@webpieces/core-util';
import { JsonValueDto as LookalikeDto } from './LookalikeJsonValueDto';

/** Settings to save. */
export interface SaveJsonRequest {
    /** Any JSON, reached through an import alias of the marker. */
    data: SettingsJson;

    /** Any JSON, or null. */
    maybe: SettingsJson | null;

    /** A class that only shares the marker's name. */
    lookalike: LookalikeDto;
}

/** What was saved. */
export interface SaveJsonResponse {
    /** Echoed JSON. */
    echoed: SettingsJson[];
}

/** The recursive JSON marker, from source to the MCP catalog (#1447). */
@ApiPath('/json')
@ApiType(MCP)
export abstract class JsonMarkerApi {
    /**
     * Saves free-form JSON.
     *
     * @summary Save JSON
     * @returns What was saved.
     */
    @Endpoint(POST, '/save', WRITE, RPC)
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @WpMcpTool('json_save')
    save(_request: SaveJsonRequest): Promise<SaveJsonResponse> {
        throw new Error('contract only');
    }
}
