/* eslint-disable */
/**
 * A contract carrying a field the model cannot give a shape to.
 *
 * `Payload` is a union of two named objects with NO property typed as one string literal on both
 * branches, so TypeScript itself cannot narrow it and the model refuses to invent a discriminator.
 * Rendering it would publish an empty schema, which in JSON Schema means "anything" — a customer-facing
 * field with no shape on a green build. The generator refuses instead, naming the pointer.
 */
import {
    ApiPath,
    ApiType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthPublic,
} from '@webpieces/core-util';

export interface ByName {
    name: string;
}

export interface ByNumber {
    count: number;
}

export type Payload = ByName | ByNumber;

export interface SendRequest {
    /** Either shape. Nothing tells them apart. */
    payload: Payload;
}

export interface SendResponse {
    accepted: boolean;
}

/** A contract with an unpublishable field. */
@ApiPath('/unmapped')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
export class UnmappedApi {
    /** Sends a payload. */
    @Endpoint(POST, '/send', READ, RPC)
    @WpAuthPublic('Fixture only.')
    send(request: SendRequest): Promise<SendResponse> {
        throw new Error('contract');
    }
}
