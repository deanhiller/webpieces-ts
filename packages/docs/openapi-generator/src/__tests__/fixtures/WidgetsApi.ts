/* eslint-disable */
/**
 * The MAIN fixture: one api-key regime on every endpoint, one method hidden from customers, one that
 * is an agent tool. It declares all three `@ApiType`s, so one manifest exercises every document.
 *
 * It uses the REAL decorators. The stub decorators it used to import are gone, and that is the point:
 * a stub cannot be wrong about the signature it stands in for, so a fixture built on stubs proves
 * nothing about the thing it is a fixture FOR.
 */
import {
    ApiPath,
    ApiType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WpAuthApiKey,
    WpMcpAuthJwt,
    WpMcpTool,
} from '@webpieces/core-util';

const PARTNER_CREDENTIALS = [
    { in: 'header', name: 'x-api-key', description: 'Your key.' },
    { in: 'bearer', description: 'The organization token.' },
] as const;

/** What a widget is for. */
export type WidgetKind = 'round' | 'square';

export interface Widget {
    /** Its identifier. */
    id: string;

    /** Its kind. */
    kind: WidgetKind;

    /** A label, PRESENT and possibly null. */
    label: string | null;

    /** When it was made. @format date-time */
    madeAt: string;
}

export interface ListWidgetsRequest {
    /** Only widgets of these kinds. Omit for every kind. */
    kinds?: WidgetKind[];
}

export interface ListWidgetsResponse {
    widgets: Widget[];
}

export interface PurgeRequest {
    /** How old, in days. */
    olderThanDays: number;
}

export interface PurgeResponse {
    purged: number;
}

/** Widgets. */
@ApiPath('/widgets')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class WidgetsApi {
    /**
     * Lists widgets.
     *
     * @mcp Read-only. Prefer this over guessing from an earlier answer.
     */
    @Endpoint(POST, '/list', READ, RPC)
    @WpAuthApiKey('partner', PARTNER_CREDENTIALS)
    @WpMcpTool({ name: 'list_widgets', description: 'List widgets.', openWorldHint: false })
    @WpMcpAuthJwt({ roles: ['agent'] })
    list(request: ListWidgetsRequest): Promise<ListWidgetsResponse> {
        throw new Error('contract');
    }

    /**
     * Deletes old widgets.
     *
     * Not published: an operator tool, and the customer contract has no concept of our retention.
     */
    @Endpoint(POST, '/purge', WRITE, RPC, { hidden: true })
    @WpAuthApiKey('partner', PARTNER_CREDENTIALS)
    purge(request: PurgeRequest): Promise<PurgeResponse> {
        throw new Error('contract');
    }
}
