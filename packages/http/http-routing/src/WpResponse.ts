/**
 * WpResponse - Wraps controller responses for the SERVER-side filter chain.
 *
 * Generic type parameter TResult represents the controller's return type.
 * The filter chain uses WpResponse<unknown> because it handles all response types uniformly.
 *
 * The jsonTranslator middleware is responsible for:
 * 1. Serializing WpResponse.response to JSON
 * 2. Writing the JSON to the HTTP response body
 * 3. Setting the HTTP status code from WpResponse.statusCode
 *
 * It stayed in http-routing when {@link Filter} / {@link Service} / {@link FilterChain} moved to
 * @webpieces/core-util, because it is the INBOUND chain's response type specifically — the outbound
 * client chain's response type is the platform `Response`. Only the abstraction is shared.
 */
// webpieces-disable no-any-unknown -- generic default: the filter chain handles all response types uniformly
export class WpResponse<TResult = unknown> {
    response: TResult;

    constructor(response: TResult) {
        this.response = response;
    }
}
