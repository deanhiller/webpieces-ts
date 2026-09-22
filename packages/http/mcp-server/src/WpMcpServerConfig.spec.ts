import 'reflect-metadata';
import express, { Express } from 'express';
import { ContainerModule, ContainerModuleLoadOptions } from 'inversify';
import { beforeAll, describe, expect, it } from 'vitest';
import { HeaderRegistry } from '@webpieces/core-util';
import { JWT_HOOK, WebpiecesRouterFactory, WebpiecesRouter } from '@webpieces/http-routing';
import { McpApiBinding } from './McpApiBinding';
import { VerifiedMcpCredential, WpMcpServerConfig } from './McpAuth';
import { McpBindOptions } from './McpBindOptions';
import { McpDeployment } from './McpDeployment';
import { WpMcpServer } from './WpMcpServer';
import {
    ENDPOINT_PATH,
    SearchApi,
    SPEC_TOOL_CATALOG,
    SearchController,
    TestJwtHook,
    TestTokenAuthority,
    USER_ID,
} from './__tests__/WpMcpServerTestFixtures';

const RESOURCE = 'https://api.example.test/app-owned/mcp';
const ISSUER = 'https://login.example.test';

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

    function complete(): WpMcpServerConfig<string, string> {
        return new WpMcpServerConfig<string, string>()
            .setName('config-spec')
            .setVersion('1.0.0')
            .setResource(RESOURCE)
            .setAccessTokenAuthority(new TestTokenAuthority())
            .setEndpointJwtAuthority(jwtHook)
            .setEndpointMintRequest((credential: VerifiedMcpCredential) => credential.subject)
            .setAuthorizationServers([ISSUER])
            .setRequiredScopes(['tools']);
    }

    function bind(config: WpMcpServerConfig<string, string>): void {
        const app: Express = express();
        new WpMcpServer(config).bind(
            app,
            new McpBindOptions(
                ENDPOINT_PATH,
                [McpApiBinding.local(SearchApi, router)],
                SPEC_TOOL_CATALOG,
                McpDeployment.singleProcess(),
            ),
        );
    }

    it('chains every setter and exposes the values it was given', () => {
        const config = complete().setMaxAccountValidationAgeSeconds(900);
        expect(config.name).toBe('config-spec');
        expect(config.version).toBe('1.0.0');
        expect(config.resource).toBe(RESOURCE);
        expect(config.authorizationServers).toEqual([ISSUER]);
        expect(config.requiredScopes).toEqual(['tools']);
        expect(config.maxAccountValidationAgeSeconds).toBe(900);
        // the untouched ceiling keeps its default
        expect(config.maxEndpointJwtLifetimeSeconds).toBe(3600);
        expect(config.errorTranslator).toBeUndefined();
        expect(config.protectedResourceMetadata().authorization_servers).toEqual([ISSUER]);
    });

    it('bind() lists EVERY missing required setter in one startup failure', () => {
        const config = new WpMcpServerConfig<string, string>()
            .setName('half-built')
            .setVersion('1.0.0');
        expect(() => bind(config)).toThrow(
            'WpMcpServerConfig is missing setResource(...), setAccessTokenAuthority(...), ' +
                'setEndpointJwtAuthority(...), setEndpointMintRequest(...), ' +
                'setAuthorizationServers(...), setRequiredScopes(...)',
        );
    });

    it('bind() names the one forgotten setter', () => {
        const config = new WpMcpServerConfig<string, string>()
            .setName('no-resource')
            .setVersion('1.0.0')
            .setAccessTokenAuthority(new TestTokenAuthority())
            .setEndpointJwtAuthority(jwtHook)
            .setEndpointMintRequest((credential: VerifiedMcpCredential) => credential.subject)
            .setAuthorizationServers([ISSUER])
            .setRequiredScopes(['tools']);
        expect(() => bind(config)).toThrow('WpMcpServerConfig is missing setResource(...)');
    });

    it('a complete config binds', () => {
        expect(() => bind(complete())).not.toThrow();
    });

    it('each text setter rejects an empty value naming itself', () => {
        const config = new WpMcpServerConfig<string, string>();
        expect(() => config.setName('  ')).toThrow(
            'WpMcpServerConfig.setName(...) requires a non-empty string.',
        );
        expect(() => config.setVersion('')).toThrow(
            'WpMcpServerConfig.setVersion(...) requires a non-empty string.',
        );
        expect(() => config.setRequiredScopes(['tools', ''])).toThrow(
            'WpMcpServerConfig.setRequiredScopes(...) requires a non-empty string.',
        );
    });

    it('setResource rejects a name or version landed on it', () => {
        const config = new WpMcpServerConfig<string, string>();
        expect(() => config.setResource('lang-learning')).toThrow(
            "WpMcpServerConfig.setResource(...) requires an absolute URL, got 'lang-learning'.",
        );
        expect(() => config.setResource('2.4.1')).toThrow(
            'WpMcpServerConfig.setResource(...) requires an absolute URL',
        );
    });

    it('setAuthorizationServers rejects a scope list landed on it', () => {
        const config = new WpMcpServerConfig<string, string>();
        expect(() => config.setAuthorizationServers(['tools'])).toThrow(
            "WpMcpServerConfig.setAuthorizationServers(...) requires an absolute URL, got 'tools'.",
        );
        expect(() => config.setAuthorizationServers([])).toThrow(
            'WpMcpServerConfig.setAuthorizationServers(...) requires at least one issuer URL.',
        );
    });

    it('setRequiredScopes accepts an explicitly empty list', () => {
        expect(() => complete().setRequiredScopes([])).not.toThrow();
    });

    it('the ceilings keep their range validation', () => {
        const config = new WpMcpServerConfig<string, string>();
        expect(() => config.setMaxAccountValidationAgeSeconds(0)).toThrow(
            'WpMcpServerConfig.setMaxAccountValidationAgeSeconds(...) requires 1..3600 seconds, got 0.',
        );
        expect(() => config.setMaxAccountValidationAgeSeconds(3601)).toThrow(
            'requires 1..3600 seconds, got 3601.',
        );
        expect(() => config.setMaxEndpointJwtLifetimeSeconds(3601)).toThrow(
            'WpMcpServerConfig.setMaxEndpointJwtLifetimeSeconds(...) requires 1..3600 seconds, got 3601.',
        );
        expect(() => config.setMaxEndpointJwtLifetimeSeconds(3600)).not.toThrow();
    });

    it('derives the RFC 9728 metadata URL by path insertion, for every resource shape', () => {
        const metadataUrlOf = (resource: string): string =>
            new WpMcpServerConfig<string, string>().setResource(resource).resourceMetadataUrl;
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
        expect(() => new WpMcpServerConfig<string, string>().resource).toThrow(
            'WpMcpServerConfig is missing setResource(...)',
        );
    });
});
