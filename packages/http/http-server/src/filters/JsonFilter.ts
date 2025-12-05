import { injectable } from 'inversify';
import { provideSingleton, MethodMeta } from '@webpieces/http-routing';
import { Filter, WpResponse, Service } from '@webpieces/http-filters';

/**
 * JsonFilter - Handles JSON request parsing and response serialization.
 * Priority: 1850 (after ContextFilter at 2000, before LogApiFilter at 1800)
 *
 * Responsibilities:
 * 1. Parse JSON request body from RouterRequest
 * 2. Store requestDto in MethodMeta for downstream filters/controller
 * 3. Serialize response DTO to JSON
 * 4. Write JSON to RouterResponse
 *
 * SYMMETRIC design with client:
 * - Server (JsonFilter): RouterRequest body → parse JSON → requestDto
 * - Client (ClientFactory): requestDto → JSON.stringify → HTTP body
 * - Server (JsonFilter): responseDto → JSON.stringify → RouterResponse
 * - Client (ClientFactory): HTTP response → parse JSON → responseDto
 *
 * This filter was moved from ExpressWrapper.executeImpl() to decouple
 * JSON handling from the Express layer.
 */
@provideSingleton()
@injectable()
export class JsonFilter extends Filter<MethodMeta, WpResponse<unknown>> {
    async filter(
        meta: MethodMeta,
        nextFilter: Service<MethodMeta, WpResponse<unknown>>,
    ): Promise<WpResponse<unknown>> {
        // 1. Parse JSON request body (for POST/PUT/PATCH)
        await this.parseRequestBody(meta);

        // 2. Invoke next filter/controller
        const wpResponse = await nextFilter.invoke(meta);

        // 3. Serialize response DTO to JSON and write to RouterResponse
        this.serializeResponse(meta, wpResponse);

        return wpResponse;
    }

    /**
     * Parse JSON request body from RouterRequest.
     * Only parses for POST/PUT/PATCH methods.
     * Stores requestDto in MethodMeta for controller to use.
     *
     * Skips parsing in test mode (no routerReqResp) - requestDto already set by createApiClient.
     */
    private async parseRequestBody(meta: MethodMeta): Promise<void> {
        const httpMethod = meta.httpMethod;

        // Only parse body for POST/PUT/PATCH
        if (!['POST', 'PUT', 'PATCH'].includes(httpMethod)) {
            return;
        }

        // Skip parsing in test mode (createApiClient sets requestDto directly)
        if (!meta.routerReqResp) {
            return;
        }

        // Read raw body from RouterRequest (Express-independent)
        const bodyText = await meta.routerReqResp.request.readBody();

        // Parse JSON
        if (bodyText) {
            try {
                meta.requestDto = JSON.parse(bodyText);
            } catch (error) {
                const err = error instanceof Error ? error.message : String(error);
                throw new Error(`Failed to parse JSON request body: ${err}`);
            }
        } else {
            meta.requestDto = {};
        }
    }

    /**
     * Serialize response DTO to JSON and write to RouterResponse.
     * This is SYMMETRIC with client's JSON parsing.
     */
    private serializeResponse(meta: MethodMeta, wpResponse: WpResponse<unknown>): void {
        if (!wpResponse.response) {
            throw new Error(
                `Route chain not returning response: ${meta.routeMeta.controllerClassName}.${meta.routeMeta.methodName}`
            );
        }

        // Skip serialization in test mode (no HTTP involved)
        if (!meta.routerReqResp) {
            return;
        }

        // Serialize response DTO to JSON (SYMMETRIC with client's response.json())
        const responseJson = JSON.stringify(wpResponse.response);

        // Write to RouterResponse
        meta.routerReqResp.response.setStatus(200);
        meta.routerReqResp.response.setHeader('Content-Type', 'application/json');
        meta.routerReqResp.response.send(responseJson);
    }
}
