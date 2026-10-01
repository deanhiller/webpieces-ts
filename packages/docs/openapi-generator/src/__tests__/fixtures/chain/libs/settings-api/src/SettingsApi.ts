/* eslint-disable */
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic } from '@webpieces/core-util';
import { AiProvider } from '@fixture/company-core';

/** Reads the settings. */
export interface SettingsRequest {
    /** Whose settings. */
    userId: string;
}

/** The settings. */
export interface SettingsResponse {
    /** The provider the user connected. */
    provider: AiProvider;
}

/** Settings. */
@ApiPath('/settings')
export class SettingsApi {
    /** Reads the settings. */
    @Endpoint(POST, '/read', READ, RPC)
    @WpAuthPublic('Fixture only.')
    read(request: SettingsRequest): Promise<SettingsResponse> {
        throw new Error('contract');
    }
}
