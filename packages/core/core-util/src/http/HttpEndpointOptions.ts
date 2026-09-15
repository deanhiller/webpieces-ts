import { ExternalSystemKind } from './external-caller';
import { ContractHttpMethod, EndpointResponseType } from './HttpContract';

/** Options for one `@Endpoint`, stored parallel to the method-to-path metadata. */
export interface EndpointOptions {
    /** HTTP verb for this route. Defaults to POST. */
    httpMethod?: ContractHttpMethod;
    /** Return only a JSON body (default), or the full transport-neutral status/header/body value. */
    responseType?: EndpointResponseType;
    /**
     * Parse the request body as application/x-www-form-urlencoded instead of JSON. The request
     * DTO must be flat; urlencoded has no nesting. Default false = JSON.
     */
    formPost?: boolean;
    /**
     * Retain the verbatim request bytes and absolute URL for a `@WpAuthWebhook` callback to verify.
     * This is retention, not new buffering: the Express adapter already accumulates the body.
     *
     * `@WpAuthWebhook` requires this option at wiring time. It combines with `formPost` for vendors
     * that sign flat form bodies, e.g. `{ formPost: true, rawBody: true }`.
     */
    rawBody?: boolean;
}

/** An external endpoint must also identify the outside system that calls it. */
export interface ExternalEndpointOptions extends EndpointOptions {
    /** The outside system (`'twilio'`) — graph identity, not display text. */
    calledBy: string;
    /** What that caller is; picks its graph shape. Defaults to `'saas'`. */
    callerKind?: ExternalSystemKind;
}
