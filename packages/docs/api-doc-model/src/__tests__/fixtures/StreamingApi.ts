import {
    ApiPath,
    Endpoint,
    POST,
    READ,
    RPC,
    RequestStream,
    ResponseStream,
    StreamDirection,
    WpAuthPublic,
    WpStream,
} from '@webpieces/core-util';

export class InitialRequest {
    room!: string;
}
export class InitialResponse {
    session!: string;
}
export class RequestEvent {
    text!: string;
}
export class ResponseEvent {
    received!: boolean;
}

@ApiPath('/stream')
export abstract class StreamingApi {
    @Endpoint(POST, '/full', READ, RPC)
    @WpAuthPublic('stream fixture')
    @WpStream(StreamDirection.FULL)
    full(
        _request: InitialRequest,
        _response: ResponseStream<ResponseEvent>,
    ): Promise<RequestStream<InitialResponse, RequestEvent>> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/response', READ, RPC)
    @WpAuthPublic('stream fixture')
    @WpStream(StreamDirection.RESPONSE)
    watch(
        _request: InitialRequest,
        _response: ResponseStream<ResponseEvent>,
    ): Promise<InitialResponse> {
        throw new Error('contract only');
    }

    @Endpoint(POST, '/request', READ, RPC)
    @WpAuthPublic('stream fixture')
    @WpStream(StreamDirection.REQUEST)
    upload(_request: InitialRequest): Promise<RequestStream<InitialResponse, RequestEvent>> {
        throw new Error('contract only');
    }
}
