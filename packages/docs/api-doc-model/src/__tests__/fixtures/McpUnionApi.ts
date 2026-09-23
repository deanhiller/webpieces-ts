import { ApiPath, ApiType, Endpoint, MCP, POST, READ, RPC, WpMcpTool } from '@webpieces/core-util';

/** A window given as a clock time. */
export interface ScheduledWindow {
    /** Discriminates this branch. */
    kind: 'scheduled';

    /** When the window opens. */
    from: string;
}

/** A window that means "as soon as possible". */
export interface AsapWindow {
    /** Discriminates this branch. */
    kind: 'asap';

    /** Roughly how long it needs, in minutes. */
    estimateMinutes: number;
}

/**
 * A DISCRIMINATED union: every branch carries `kind` as one string literal, so a renderer can narrow
 * it exactly as TypeScript does.
 */
export type DeliveryWindow = ScheduledWindow | AsapWindow;

/** Asks for one delivery. */
export interface FetchRequest {
    /** The order to look at. */
    orderId: string;
}

/** One delivery. */
export interface FetchResponse {
    /**
     * When it is meant to arrive. NESTED inside a property, which is the legal place for a union —
     * see the root-union tool below.
     */
    window: DeliveryWindow;
}

/** Asks to move a window to a clock time. */
export interface MoveToScheduled {
    /** Discriminates this branch. */
    kind: 'scheduled';

    /** The new opening time. */
    from: string;
}

/** Asks to move a window to "as soon as possible". */
export interface MoveToAsap {
    /** Discriminates this branch. */
    kind: 'asap';

    /** Roughly how long it needs, in minutes. */
    estimateMinutes: number;
}

/**
 * A request that IS a union — the shape both the OpenAI and the Anthropic function-calling APIs
 * reject at the TOP level of a tool's parameters. Declared here so the renderer's refusal is
 * measured against a real contract rather than a hand-built model.
 */
export type MoveWindowRequest = MoveToScheduled | MoveToAsap;

/** The result of moving a window. */
export interface MoveWindowResponse {
    /** Whether anything changed. */
    moved: boolean;
}

/** Deliveries, for the union tests. */
@ApiType(MCP)
@ApiPath('/deliveries')
export abstract class McpUnionApi {
    /** Reads one delivery, whose window is a discriminated union. */
    @WpMcpTool('fetch_delivery')
    @Endpoint(POST, '/fetch', READ, RPC)
    fetchDelivery(_request: FetchRequest): Promise<FetchResponse> {
        throw new Error('contract only');
    }

    /** Moves a delivery window. Its REQUEST is a union, which no tool schema may publish. */
    @WpMcpTool('move_window')
    @Endpoint(POST, '/move', READ, RPC)
    moveWindow(_request: MoveWindowRequest): Promise<MoveWindowResponse> {
        throw new Error('contract only');
    }
}
