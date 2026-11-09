import { AuthorizationService } from '@webpieces/http-routing';
import 'reflect-metadata';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { beforeAll, describe, expect, it } from 'vitest';
import { Mcp, HeaderRegistry, oidcSameProject } from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory, WebpiecesRouter } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import {
    VerifiedMcpCredential,
    WpMcpServerConfig,
    McpAccessTokenFormat,
    mcpOAuth,
    McpOAuthMode,
} from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpToolset } from './McpToolset';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import {
    ENDPOINT_PATH,
    SearchApi,
    SEARCH_API_CATALOG,
    SearchController,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

const RESOURCE = 'https://api.example.test/app-owned/mcp';
const ISSUER = 'https://login.example.test';
const TITLE = 'Config Spec';
const DESCRIPTION = 'Pins the WpMcpServerConfig fluent setters.';
const WEBSITE = 'https://docs.example.test/config-spec';

/**
 * The positional constructor these setters replaced had eight required positions, five of which were
 * swappable with no compile error (three adjacent bare strings, two adjacent string arrays). A swap
 * built, bound and started cleanly and then 401'd every request with `issuer is not trusted` — the
 * OAuth discovery signal, so a client answered it by re-authenticating, forever. These specs pin the
 * replacement: name beside value, per-setter validation, and one startup failure naming every
 * forgotten setter.
 */
describe('WpMcpServerConfig fluent setters', () => {
    let jwtHook: TestJwtHook;
    let router: WebpiecesRouter;

    beforeAll(async () => {
        HeaderRegistry.configure([USER_ID], true);
        jwtHook = new TestJwtHook();
        const module = new ContainerModule((options: ContainerModuleLoadOptions) => {
            options.bind(JWT_HOOK).toConstantValue(jwtHook);
        });
        router = await WebpiecesRouterFactory.create({ appBindings: [module] });
        router.addRoutes(SearchApi, SearchController);
    });

    function oauth(maxAccountValidationAgeSeconds?: number): McpOAuthMode {
        return mcpOAuth(
            new TestTokenAuthority(),
            [ISSUER],
            ['tools'],
            McpAccessTokenFormat.everyBearer(),
            maxAccountValidationAgeSeconds,
        );
    }

    function complete(): WpMcpServerConfig {
        return new WpMcpServerConfig()
            .setName('config-spec')
            .setTitle(TITLE)
            .setDescription(DESCRIPTION)
            .setWebsiteUrl(WEBSITE)
            .setVersion('1.0.0')
            .setResource(RESOURCE)
            .setAuth([
                mcpOAuth(
                    new TestTokenAuthority(),
                    [ISSUER],
                    ['tools'],
                    McpAccessTokenFormat.everyBearer(),
                ),
            ]);
    }

    function bind(config: WpMcpServerConfig): void {
        const app: Express = express();
        new WpMcpServer(
            config,
            new McpToolset(
                [McpApiBinding.local(SearchApi, router)],
                [SEARCH_API_CATALOG],
                router.authorizationService(),
                [Mcp.DEFAULT],
            ),
        ).bind(app, new McpBindOptions(ENDPOINT_PATH, McpDeployment.singleProcess()));
    }

    it('chains every setter and exposes the values it was given', () => {
        const mode = oauth(900);
        const config = complete().setAuth([mode]);
        expect(config.name).toBe('config-spec');
        expect(config.title).toBe(TITLE);
        expect(config.description).toBe(DESCRIPTION);
        expect(config.websiteUrl).toBe(WEBSITE);
        expect(config.version).toBe('1.0.0');
        expect(config.resource).toBe(RESOURCE);
        expect(config.auth).toEqual([mode]);
        expect(mode.authorizationServers).toEqual([ISSUER]);
        expect(mode.requiredScopes).toEqual(['tools']);
        expect(mode.maxAccountValidationAgeSeconds).toBe(900);
        expect(mode.protectedResourceMetadata(config.resource).authorization_servers).toEqual([
            ISSUER,
        ]);
        expect(config.credentialVerifiers).toBeUndefined();
    });

    it('bind() lists EVERY missing required setter in one startup failure', () => {
        const config = new WpMcpServerConfig().setName('half-built').setVersion('1.0.0');
        expect(() => bind(config)).toThrow(
            'WpMcpServerConfig is missing setTitle(...), setDescription(...), setWebsiteUrl(...), ' +
                'setResource(...), setAuth([...])',
        );
    });

    it('bind() demands the credential verifiers once an @WpAuth mode is in the set', () => {
        const config = complete().setAuth([oidcSameProject()]);
        expect(() => bind(config)).toThrow(
            'WpMcpServerConfig is missing setCredentialVerifiers(router.credentialVerifiers())',
        );
        expect(() =>
            bind(
                complete()
                    .setAuth([oidcSameProject()])
                    .setCredentialVerifiers(router.credentialVerifiers()),
            ),
        ).not.toThrow();
    });

    it('bind() names the one forgotten setter', () => {
        const config = new WpMcpServerConfig()
            .setName('no-resource')
            .setTitle(TITLE)
            .setDescription(DESCRIPTION)
            .setWebsiteUrl(WEBSITE)
            .setVersion('1.0.0')
            .setAuth([
                mcpOAuth(
                    new TestTokenAuthority(),
                    [ISSUER],
                    ['tools'],
                    McpAccessTokenFormat.everyBearer(),
                ),
            ]);
        expect(() => bind(config)).toThrow('WpMcpServerConfig is missing setResource(...)');
    });

    it.each(['setTitle', 'setDescription', 'setWebsiteUrl'])(
        'bind() names a forgotten %s(...) on its own',
        (setter: string) => {
            const config = complete();
            // Rebuild without the one setter under test: every other required value is present.
            const partial = new WpMcpServerConfig()
                .setName(config.name)
                .setVersion(config.version)
                .setResource(config.resource)
                .setAuth(config.auth);
            if (setter !== 'setTitle') partial.setTitle(TITLE);
            if (setter !== 'setDescription') partial.setDescription(DESCRIPTION);
            if (setter !== 'setWebsiteUrl') partial.setWebsiteUrl(WEBSITE);
            expect(() => bind(partial)).toThrow(`WpMcpServerConfig is missing ${setter}(...)`);
        },
    );

    it('setTitle requires one non-empty line of at most 100 characters', () => {
        const config = new WpMcpServerConfig();
        expect(() => config.setTitle(' ')).toThrow(
            'WpMcpServerConfig.setTitle(...) requires a non-empty string.',
        );
        expect(() => config.setTitle('Line one\nLine two')).toThrow(
            'WpMcpServerConfig.setTitle(...) requires a single line of text.',
        );
        expect(() => config.setTitle('x'.repeat(101))).toThrow(
            'WpMcpServerConfig.setTitle(...) allows at most 100 characters, got 101.',
        );
        expect(config.setTitle('x'.repeat(100)).title).toHaveLength(100);
    });

    it('setDescription requires non-empty text of at most 2000 characters', () => {
        const config = new WpMcpServerConfig();
        expect(() => config.setDescription('')).toThrow(
            'WpMcpServerConfig.setDescription(...) requires a non-empty string.',
        );
        expect(() => config.setDescription('d'.repeat(2001))).toThrow(
            'WpMcpServerConfig.setDescription(...) allows at most 2000 characters, got 2001.',
        );
        const multiLine = 'First paragraph.\n\nSecond paragraph.';
        expect(config.setDescription(multiLine).description).toBe(multiLine);
        expect(config.setDescription('d'.repeat(2000)).description).toHaveLength(2000);
    });

    it('setWebsiteUrl requires an absolute https URL', () => {
        const config = new WpMcpServerConfig();
        expect(() => config.setWebsiteUrl('')).toThrow(
            'WpMcpServerConfig.setWebsiteUrl(...) requires a non-empty string.',
        );
        expect(() => config.setWebsiteUrl('docs.example.test')).toThrow(
            "WpMcpServerConfig.setWebsiteUrl(...) requires an absolute URL, got 'docs.example.test'.",
        );
        expect(() => config.setWebsiteUrl('http://docs.example.test')).toThrow(
            "WpMcpServerConfig.setWebsiteUrl(...) requires an https:// URL, got 'http://docs.example.test'.",
        );
        expect(config.setWebsiteUrl(WEBSITE).websiteUrl).toBe(WEBSITE);
    });

    it('a complete config binds', () => {
        expect(() => bind(complete())).not.toThrow();
    });

    it('each text setter rejects an empty value naming itself', () => {
        const config = new WpMcpServerConfig();
        expect(() => config.setName('  ')).toThrow(
            'WpMcpServerConfig.setName(...) requires a non-empty string.',
        );
        expect(() => config.setVersion('')).toThrow(
            'WpMcpServerConfig.setVersion(...) requires a non-empty string.',
        );
        expect(() =>
            mcpOAuth(
                new TestTokenAuthority(),
                [ISSUER],
                ['tools', ''],
                McpAccessTokenFormat.everyBearer(),
            ),
        ).toThrow('mcpOAuth(...) requires an array of nonblank required scopes');
    });

    it('setResource rejects a name or version landed on it', () => {
        const config = new WpMcpServerConfig();
        expect(() => config.setResource('lang-learning')).toThrow(
            "WpMcpServerConfig.setResource(...) requires an absolute URL, got 'lang-learning'.",
        );
        expect(() => config.setResource('2.4.1')).toThrow(
            'WpMcpServerConfig.setResource(...) requires an absolute URL',
        );
    });

    it('mcpOAuth(...) rejects a scope list landed on its authorization servers', () => {
        expect(() =>
            mcpOAuth(
                new TestTokenAuthority(),
                ['tools'],
                ['tools'],
                McpAccessTokenFormat.everyBearer(),
            ),
        ).toThrow("mcpOAuth(...) authorization servers must be absolute URLs, got 'tools'.");
        expect(() =>
            mcpOAuth(
                new TestTokenAuthority(),
                [] as unknown as [string],
                ['tools'],
                McpAccessTokenFormat.everyBearer(),
            ),
        ).toThrow('mcpOAuth(...) requires at least one authorization server issuer URL.');
    });

    it('mcpOAuth(...) accepts an explicitly empty required-scope list', () => {
        expect(() =>
            mcpOAuth(new TestTokenAuthority(), [ISSUER], [], McpAccessTokenFormat.everyBearer()),
        ).not.toThrow();
    });

    it('validates icon origins at bind, regardless of setter order', () => {
        const config = complete().setIcons([{ src: 'https://other.example.test/icon.png' }]);
        expect(() => bind(config)).toThrow('requires HTTPS icons on the resource origin');
        expect(() =>
            complete()
                .setIcons([{ src: 'data:image/png;base64,aWNvbg==' }])
                .validate(),
        ).not.toThrow();
    });

    it('the ceilings keep their range validation', () => {
        expect(() => oauth(0)).toThrow(
            'mcpOAuth(...) maxAccountValidationAgeSeconds must be 1..3600, got 0.',
        );
        expect(() => oauth(3601)).toThrow('must be 1..3600, got 3601.');
    });

    it('an opaque token prefix may not overlap a JWT or an off-GCP OIDC token', () => {
        expect(() => McpAccessTokenFormat.opaquePrefix('eyJ')).toThrow(/every JWT starts with/);
        expect(() => McpAccessTokenFormat.opaquePrefix('dev')).toThrow(/off-GCP OIDC token/);
        expect(McpAccessTokenFormat.opaquePrefix('wpmcp_').prefix).toBe('wpmcp_');
    });

    it('derives the RFC 9728 metadata URL by path insertion, for every resource shape', () => {
        const metadataUrlOf = (resource: string): string =>
            new WpMcpServerConfig().setResource(resource).resourceMetadataUrl;
        expect(metadataUrlOf(RESOURCE)).toBe(
            'https://api.example.test/.well-known/oauth-protected-resource/app-owned/mcp',
        );
        expect(metadataUrlOf('https://h.example.test/mcp')).toBe(
            'https://h.example.test/.well-known/oauth-protected-resource/mcp',
        );
        // a root-path resource appends nothing: no trailing slash on the metadata URL
        expect(metadataUrlOf('https://h.example.test/')).toBe(
            'https://h.example.test/.well-known/oauth-protected-resource',
        );
        expect(metadataUrlOf('https://h.example.test')).toBe(
            'https://h.example.test/.well-known/oauth-protected-resource',
        );
        expect(metadataUrlOf('https://h.example.test/a/b')).toBe(
            'https://h.example.test/.well-known/oauth-protected-resource/a/b',
        );
        expect(metadataUrlOf('http://localhost:8300/mcp')).toBe(
            'http://localhost:8300/.well-known/oauth-protected-resource/mcp',
        );
    });

    it('bind() refuses a resource whose path is not the endpointPath', () => {
        expect(() => bind(complete().setResource('https://api.example.test/mcp-v2'))).toThrow(
            `MCP resource path '/mcp-v2' must equal endpointPath '${ENDPOINT_PATH}'`,
        );
    });

    it('reading an unset required value names the setter that fills it', () => {
        expect(() => new WpMcpServerConfig().resource).toThrow(
            'WpMcpServerConfig is missing setResource(...)',
        );
    });
});
