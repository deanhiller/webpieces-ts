import 'reflect-metadata';
import { Server } from 'node:http';
import express from 'express';
import { ContainerModule, ContainerModuleLoadOptions, injectable } from 'inversify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
    ApiJsonSchema,
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    HeaderRegistry,
    Mcp,
    MCP,
    McpToolCatalogFile,
    McpToolDefinition,
    mcpHintsForOperation,
    ObjectSchemaBuilder,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuth,
    WpAuthorization,
    WpMcpTool,
    jwt,
} from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { McpToolCatalog } from './McpToolCatalog';
import { WpMcpServer } from './WpMcpServer';
import { McpHttpTestHarness, TestServers } from './__tests__/McpHttpTestHarness';
import { TestJwtHook, TestTokenAuthority, USER_ID } from './__tests__/WpMcpServerTestFixtures';

/**
 * A NULLABLE string enum on an MCP tool's output, end to end through `WpMcpServer` (#1197).
 *
 * `x: SomeEnumDto | null` used to publish `{type: ["string","null"], enum: [...values]}`. JSON Schema
 * checks `enum` independently of `type`, so the MCP SDK's own output validation refused `{x: null}`
 * with "must be equal to one of the allowed values" and the whole tool call failed, although `null`
 * was the documented value. The generator now writes `null` into `enum` too; this spec boots the real
 * server on that shape, round-tripped through the catalog JSON exactly as `wp-openapi` writes it.
 *
 * The catalog is built by hand (as every spec of this package does — the runtime is HANDED a catalog
 * and does not depend on the compiler API); `StringEnumSchema.spec.ts` in api-doc-model proves the
 * generator emits exactly this shape from the source.
 */
enum ResumeFormatDto {
    MODERN = 'MODERN',
    CLASSIC = 'CLASSIC',
}

class FormatRequest {
    /** Which answer the fixture controller should return. */
    query!: string;
}

class FormatResponse {
    /** The chosen format, or null when none was chosen yet. */
    resumeFormat!: ResumeFormatDto | null;
    /** Always present: a NON-nullable enum. */
    status!: ResumeFormatDto;
}

@ApiPath('/nullable-enum-spec')
@ApiType(SVC_TO_SVC, MCP)
abstract class NullableEnumApi {
    /**
     * Reads the chosen résumé format.
     *
     * @summary Get format
     */
    @WpAuth([jwt()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/format', READ, RPC)
    @WpMcpTool('get_format')
    format(_request: FormatRequest): Promise<FormatResponse> {
        throw new Error('contract');
    }
}

class FormatResponseValue extends FormatResponse {
    constructor(resumeFormat: ResumeFormatDto | null, status: ResumeFormatDto | null) {
        super();
        this.resumeFormat = resumeFormat;
        // The 'bad-status' case deliberately breaks the contract to prove null is still refused.
        this.status = status as ResumeFormatDto;
    }
}

@injectable()
class NullableEnumController extends NullableEnumApi {
    override async format(request: FormatRequest): Promise<FormatResponse> {
        if (request.query === 'none') return new FormatResponseValue(null, ResumeFormatDto.MODERN);
        if (request.query === 'bad-status') return new FormatResponseValue(null, null);
        return new FormatResponseValue(ResumeFormatDto.CLASSIC, ResumeFormatDto.MODERN);
    }
}

const VALUES = [ResumeFormatDto.MODERN, ResumeFormatDto.CLASSIC];

function outputSchema(nullInEnum: boolean): ApiJsonSchema {
    const resumeFormat = new ApiJsonSchema(['string', 'null']);
    resumeFormat.enum = nullInEnum ? [...VALUES, null] : [...VALUES];
    resumeFormat.description = 'The chosen format, or null when none was chosen yet.';
    const status = new ApiJsonSchema('string');
    status.enum = [...VALUES];
    status.description = 'Always present: a NON-nullable enum.';
    return new ObjectSchemaBuilder()
        .required('resumeFormat', resumeFormat)
        .required('status', status)
        .build();
}

/** The catalog as the build writes it, read back through the same parser the server boots with. */
function catalogOf(nullInEnum: boolean): McpToolCatalog {
    const query = new ApiJsonSchema('string');
    query.description = 'Which answer the fixture controller should return.';
    const tool = new McpToolDefinition(
        'get_format',
        'Get format',
        'format',
        'Reads the chosen résumé format.',
        mcpHintsForOperation(READ, false),
        new ObjectSchemaBuilder().required('query', query).build(),
        outputSchema(nullInEnum),
        [Mcp.DEFAULT],
    );
    const fileName = McpToolCatalogFile.fileNameFor('NullableEnumApi');
    return new McpToolCatalog(
        McpToolCatalogFile.fromJsonText(fileName, JSON.stringify([tool])),
        '(nullable enum fixture)',
    );
}

class Mount {
    bridge!: WpMcpServer<string>;
    client!: McpHttpTestHarness;
    constructor(
        readonly path: string,
        readonly nullInEnum: boolean,
    ) {}
}

describe('a NULLABLE string enum in an MCP tool output (#1197)', () => {
    const fixed = new Mount('/mcp/fixed', true);
    const preFix = new Mount('/mcp/pre-fix', false);
    let http: Server;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        const router = await WebpiecesRouterFactory.create({
            appBindings: [
                new ContainerModule((options: ContainerModuleLoadOptions) => {
                    options.bind(JWT_HOOK).toConstantValue(new TestJwtHook());
                }),
            ],
        });
        router.addRoutes(NullableEnumApi, NullableEnumController);
        const app = express();
        for (const mount of [fixed, preFix]) {
            mount.bridge = new WpMcpServer(
                new WpMcpServerConfig<string>()
                    .setName('nullable-enum')
                    .setTitle('Webpieces Test Server')
                    .setDescription('Exercises the webpieces MCP bridge in the mcp-server test suite.')
                    .setWebsiteUrl('https://docs.example.test/mcp')
                    .setVersion('1')
                    .setResource(`https://api.example.test${mount.path}`)
                    .setAccessTokenAuthority(new TestTokenAuthority())
                    .setAuthorizationService(router.authorizationService())
                    .setAuthorizationServers(['https://login.example.test'])
                    .setRequiredScopes(['tools']),
            );
            mount.bridge.bind(
                app,
                new McpBindOptions(
                    mount.path,
                    [McpApiBinding.local(NullableEnumApi, router)],
                    [catalogOf(mount.nullInEnum)],
                    McpDeployment.singleProcess(),
                ),
            );
        }
        http = await TestServers.listen(app);
        for (const mount of [fixed, preFix]) {
            mount.client = new McpHttpTestHarness(TestServers.urlOf(http), mount.path);
        }
    });

    afterAll(async () => {
        await Promise.all([fixed.bridge.close(), preFix.bridge.close()]);
        await TestServers.close(http);
    });

    it('publishes null in BOTH type and enum, and the catalog parser keeps it', async () => {
        const reply = await fixed.client.post(fixed.client.request('tools/list'), 'mcp-user');
        const tools = fixed.client.resultOf(reply.payload)['tools'] as Array<Record<string, unknown>>;
        const output = tools[0]['outputSchema'] as Record<string, Record<string, unknown>>;
        const property = output['properties']['resumeFormat'] as Record<string, unknown>;
        expect(property['type']).toEqual(['string', 'null']);
        expect(property['enum']).toEqual(['MODERN', 'CLASSIC', null]);
    });

    it('succeeds with structured content when the tool returns null for the nullable enum', async () => {
        const payload = await fixed.client.callTool('get_format', { query: 'none' });
        expect(fixed.client.resultOf(payload)['isError']).toBeUndefined();
        expect(fixed.client.structuredOf(payload)).toEqual({
            resumeFormat: null,
            status: 'MODERN',
        });
    });

    it('still succeeds with a real enum value', async () => {
        const payload = await fixed.client.callTool('get_format', { query: 'chosen' });
        expect(fixed.client.structuredOf(payload)).toEqual({
            resumeFormat: 'CLASSIC',
            status: 'MODERN',
        });
    });

    it('still REFUSES null on a NON-nullable enum', async () => {
        const payload = await fixed.client.callTool('get_format', { query: 'bad-status' });
        expect(fixed.client.resultOf(payload)['isError']).toBe(true);
        expect(JSON.stringify(payload)).not.toContain('"status":null}');
    });

    it('control: the pre-fix shape (null in type, not in enum) fails the same call — the bug this guards', async () => {
        const payload = await preFix.client.callTool('get_format', { query: 'none' });
        const failed =
            payload.error !== undefined || preFix.client.resultOf(payload)['isError'] === true;
        expect(failed).toBe(true);
    });
});
