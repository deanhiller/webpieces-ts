/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    InvalidEndpointForMcp,
    JsonValueDto,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
    WpMcpTool,
    WRITE,
} from '@webpieces/core-util';

/** One extensible setting, validated against a server-owned definition. */
export class SettingDto {
    /** The setting's key. */
    key!: string;

    /** The setting's value — any JSON. */
    value!: JsonValueDto;

    /** The value it had before, or null when it is new. */
    previous!: JsonValueDto | null;

    /** The values a picker may offer. */
    choices?: JsonValueDto[];
}

/** Which settings to save. */
export class SaveSettingsRequest {
    /** The settings, in order. */
    settings!: SettingDto[];

    /** Free-form values per scope. */
    byScope!: Record<string, JsonValueDto>;
}

/** What was saved. */
export class SaveSettingsResponse {
    /** How many settings were saved. */
    saved!: number;
}

/** Which raw upload to read. */
export class ReadUploadRequest {
    /** The upload's identifier. */
    uploadId!: string;
}

/** The raw upload. */
export class ReadUploadResponse {
    /** The upload's bytes, base64. */
    content!: string;
}

/** Settings carrying free-form JSON (#1447). */
@ApiPath('/settings')
@ApiType(SVC_TO_SVC, MCP)
export class SettingsApi {
    /**
     * Saves settings.
     *
     * @summary Save settings
     * @returns What was saved.
     */
    @Endpoint(POST, '/save', WRITE, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('save_settings')
    saveSettings(request: SaveSettingsRequest): Promise<SaveSettingsResponse> {
        throw new Error('contract');
    }

    /**
     * Reads a raw upload.
     *
     * @summary Read an upload
     * @returns The raw upload.
     */
    @Endpoint(POST, '/upload', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @InvalidEndpointForMcp('Fixture only: raw bytes are not an agent tool.')
    readUpload(request: ReadUploadRequest): Promise<ReadUploadResponse> {
        throw new Error('contract');
    }
}
