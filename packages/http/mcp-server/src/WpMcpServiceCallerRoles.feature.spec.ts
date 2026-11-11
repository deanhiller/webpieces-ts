import 'reflect-metadata';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiJsonSchema,
    ApiPath,
    ApiType,
    ApiUnauthorizedError,
    AuthorizationType,
    Endpoint,
    HeaderRegistry,
    MCP,
    MCP_INVOCATION_CONTEXT,
    Mcp,
    McpToolCatalogFile,
    McpToolDefinition,
    ObjectSchemaBuilder,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WRITE,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    WpMcpToolHints,
    WebpiecesCoreHeaders,
    jwt as jwtAuth,
} from '@webpieces/core-util';
import { AuthenticatedMachineIdentity, RequestContext } from '@webpieces/core-context';
import {
    AuthenticatedCaller,
    JWT_HOOK,
    JwtHook,
    MintedJwt,
    WebpiecesRouterFactory,
} from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import {
    McpAccessTokenAuthority,
    McpAccessTokenFormat,
    VerifiedMcpCredential,
    WpMcpServerConfig,
    mcpOAuth,
} from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpToolCatalog } from './McpToolCatalog';
import { McpToolset } from './McpToolset';
import { WpMcpServer } from './WpMcpServer';
import { McpHttpTestHarness, RpcResponse, TestServers } from './__tests__/McpHttpTestHarness';

/**
 * #1420: a service / AI agent is a caller with ROLES and NO user id. An `mcpOAuth` authority that
 * resolves an agent token to `new AuthenticatedCaller(undefined, ['order-bot'], ..., machine)` must
 * see and call a `ROLES ['admin', 'order-bot']` tool through the real door, toolset, dispatcher and
 * receiving endpoint; an agent without the role must neither see nor call it; and `ALL_USERS` must
 * still refuse a machine, roles or not. Only the token authority (the edge) is a test double.
 */

const ENDPOINT_PATH = '/service-roles/mcp';

export class ShipRequest {
    /** Order to ship */
    orderId!: string;
}

export class ShipResponse {
    /** Subject the MCP invocation reported */
    subject!: string;

    /** Roles the MCP invocation reported, comma-joined */
    roles!: string;

    /** USER_ID the endpoint saw, or `none` */
    userId!: string;
}

@ApiPath('/service-roles')
@ApiType(SVC_TO_SVC, MCP)
abstract class OrdersApi {
    /**
     * Ship an order.
     *
     * @summary Ship order
     */
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['admin', 'order-bot'] })
    @Endpoint(POST, '/ship', WRITE, RPC)
    @WpMcpTool('orders_ship')
    ship(_request: ShipRequest): Promise<ShipResponse> {
        throw new Error('contract only');
    }

    /**
     * The caller's own orders.
     *
     * @summary My orders
     */
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/mine', READ, RPC)
    @WpMcpTool('orders_mine')
    mine(_request: ShipRequest): Promise<ShipResponse> {
        throw new Error('contract only');
    }
}

/** Every order the receiving endpoint actually shipped, across the whole suite. */
const shipped: string[] = [];

@injectable()
class OrdersController extends OrdersApi {
    override async ship(request: ShipRequest): Promise<ShipResponse> {
        shipped.push(request.orderId);
        return this.facts();
    }

    override async mine(_request: ShipRequest): Promise<ShipResponse> {
        return this.facts();
    }

    private facts(): ShipResponse {
        const invocation = RequestContext.getTrusted(MCP_INVOCATION_CONTEXT);
        const response = new ShipResponse();
        response.subject = invocation?.subject ?? 'missing';
        response.roles = (invocation?.roles ?? []).join(',');
        response.userId = RequestContext.getTrusted(WebpiecesCoreHeaders.USER_ID) ?? 'none';
        return response;
    }
}

function stringField(description: string): ApiJsonSchema {
    const schema = new ApiJsonSchema('string');
    schema.description = description;
    return schema;
}

function ordersTool(name: string, methodName: string, title: string, description: string): McpToolDefinition {
    return new McpToolDefinition(
        name,
        title,
        methodName,
        description,
        new WpMcpToolHints(false, false, false, false),
        new ObjectSchemaBuilder().required('orderId', stringField('Order to ship')).build(),
        new ObjectSchemaBuilder()
            .required('subject', stringField('Subject the MCP invocation reported'))
            .required('roles', stringField('Roles the MCP invocation reported, comma-joined'))
            .required('userId', stringField('USER_ID the endpoint saw, or `none`'))
            .build(),
        [Mcp.DEFAULT],
    );
}

const ORDERS_CATALOG = new McpToolCatalog(
    new McpToolCatalogFile('OrdersApi', [
        ordersTool('orders_ship', 'ship', 'Ship order', 'Ship an order.'),
        ordersTool('orders_mine', 'mine', 'My orders', "The caller's own orders."),
    ]),
    '(built in memory by the spec)',
);

/** The endpoint's jwt() must be verifiable for the router to boot; MCP never parses one. */
class UnusedJwtHook extends JwtHook<string> {
    override async mint(_request: string): Promise<MintedJwt> {
        throw new Error('not used');
    }

    override async parseJwt(_token: string): Promise<AuthenticatedCaller> {
        throw new Error('MCP must never parse endpoint JWTs');
    }
}

/**
 * The application's MCP token authority — the edge. `agent-order-bot` is an AI agent granted the
 * `order-bot` role; `agent-plain` is an agent granted nothing; `user-plain` is a human with no roles.
 */
class AgentTokenAuthority implements McpAccessTokenAuthority<string> {
    async mintAccessToken(_grant: string): Promise<never> {
        throw new Error('not used');
    }

    async verifyAccessToken(token: string, resource: string): Promise<VerifiedMcpCredential> {
        const now = Math.floor(Date.now() / 1000);
        return new VerifiedMcpCredential(
            token,
            'https://login.example.test',
            resource,
            now,
            now + 60,
            ['tools'],
            now,
            this.callerOf(token),
        );
    }

    private callerOf(token: string): AuthenticatedCaller {
        switch (token) {
            case 'agent-order-bot':
                return new AuthenticatedCaller(undefined, ['order-bot'], [], {}, new AuthenticatedMachineIdentity('mcp-oauth', 'agent-order-bot'));
            case 'agent-plain':
                return new AuthenticatedCaller(undefined, [], [], {}, new AuthenticatedMachineIdentity('mcp-oauth', 'agent-plain'));
            case 'user-plain':
                return new AuthenticatedCaller('user-plain', []);
            default:
                throw new ApiUnauthorizedError('unknown token');
        }
    }
}

describe('MCP: a service / AI agent is a caller with roles and no user id (#1420)', () => {
    let bridge: WpMcpServer;
    let httpServer: Server;
    let harness: McpHttpTestHarness;

    beforeAll(async () => {
        if (!HeaderRegistry.isConfigured()) HeaderRegistry.configure([], true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new UnusedJwtHook());
                }),
            ],
        });
        router.addRoutes(OrdersApi, OrdersController);
        bridge = new WpMcpServer(
            new WpMcpServerConfig()
                .setName('service-caller-roles-spec')
                .setTitle('Service Caller Roles')
                .setDescription('Proves a role-bearing AI agent with no user id is authorized by ROLES.')
                .setWebsiteUrl('https://docs.example.test/mcp')
                .setVersion('1.0.0')
                .setResource('https://api.example.test/service-roles/mcp')
                .setAuth([mcpOAuth(new AgentTokenAuthority(), ['https://login.example.test'], ['tools'], McpAccessTokenFormat.everyBearer())]),
            new McpToolset([McpApiBinding.local(OrdersApi, router)], [ORDERS_CATALOG], router.authorizationService(), [Mcp.DEFAULT]),
        );
        const app = express();
        bridge.bind(app, new McpBindOptions(ENDPOINT_PATH, McpDeployment.singleProcess()));
        httpServer = await TestServers.listen(app);
        harness = new McpHttpTestHarness(TestServers.urlOf(httpServer), ENDPOINT_PATH);
    });

    afterAll(async () => {
        await bridge.close();
        await TestServers.close(httpServer);
    });

    async function toolNames(token: string): Promise<string[]> {
        const reply = await harness.post(harness.request('tools/list'), token);
        const tools = harness.resultOf(reply.payload)['tools'] as Array<Record<string, unknown>>;
        return tools.map((tool: Record<string, unknown>) => String(tool['name']));
    }

    function unknownTool(payload: RpcResponse, name: string): void {
        expect(payload.error).toMatchObject({ code: -32602, message: `Unknown tool: ${name}` });
    }

    it('an agent granted order-bot sees and calls the ROLES tool, and the invocation reports its roles', async () => {
        expect(await toolNames('agent-order-bot')).toContain('orders_ship');

        const reply = await harness.callTool('orders_ship', { orderId: 'o-1' }, 'agent-order-bot');

        expect(harness.structuredOf(reply)).toEqual({ subject: 'agent-order-bot', roles: 'order-bot', userId: 'none' });
        expect(shipped).toEqual(['o-1']);
    });

    it('an agent without the role neither sees nor calls the ROLES tool', async () => {
        const before = shipped.length;

        expect(await toolNames('agent-plain')).not.toContain('orders_ship');
        unknownTool(await harness.callTool('orders_ship', { orderId: 'o-2' }, 'agent-plain'), 'orders_ship');

        expect(shipped).toHaveLength(before);
    });

    it('a user with no roles is still denied the ROLES tool', async () => {
        expect(await toolNames('user-plain')).not.toContain('orders_ship');
        unknownTool(await harness.callTool('orders_ship', { orderId: 'o-3' }, 'user-plain'), 'orders_ship');
    });

    it('ALL_USERS refuses a roles-bearing machine caller with no user id, and still admits a user', async () => {
        expect(await toolNames('agent-order-bot')).not.toContain('orders_mine');
        unknownTool(await harness.callTool('orders_mine', { orderId: 'o-4' }, 'agent-order-bot'), 'orders_mine');

        expect(harness.structuredOf(await harness.callTool('orders_mine', { orderId: 'o-5' }, 'user-plain'))).toEqual({
            subject: 'user-plain',
            roles: '',
            userId: 'user-plain',
        });
    });
});
