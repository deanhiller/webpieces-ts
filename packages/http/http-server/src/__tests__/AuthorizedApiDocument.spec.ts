import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { ContainerModule, ContainerModuleLoadOptions, inject, injectable } from 'inversify';
import { ApiPath, AuthorizationType, Endpoint, HeaderRegistry, jwt, POST, READ, RouteMetadataFactory, RPC, WpAuth, WpAuthorization } from '@webpieces/core-util';
import { ApiDocumentObject, AuthenticatedCaller, AuthorizationService, AuthorizedApiDocument, JWT_HOOK, JwtHook, MintedJwt, WebpiecesRouterFactory } from '@webpieces/http-routing';
import { WebpiecesExpressRouter } from '../WebpiecesExpressRouter';

@ApiPath('/inventory')
abstract class InventoryApi {
    @Endpoint(POST, '/browse', READ, RPC)
    @WpAuth([jwt()])
    @WpAuthorization({authType:AuthorizationType.ALL_USERS})
    browse(_request: object): Promise<object> { throw new Error('contract'); }

    @Endpoint(POST, '/private', READ, RPC)
    @WpAuth([jwt()])
    @WpAuthorization({authType:AuthorizationType.ROLES,roles:['inventory-admin']})
    privateData(_request: object): Promise<object> { throw new Error('contract'); }
}

@ApiPath('/documents')
abstract class DocumentsApi {
    @Endpoint(POST, '/openapi', READ, RPC)
    @WpAuth([jwt()])
    @WpAuthorization({authType:AuthorizationType.ALL_USERS})
    openapi(_request: object): Promise<ApiDocumentObject> { throw new Error('contract'); }
}

const catalog: ApiDocumentObject = {
    openapi:'3.1.0',
    tags:[{name:'browse'},{name:'private'}],
    paths:{
        '/inventory/browse':{post:{operationId:'InventoryApi_browse',tags:['browse'],responses:{'200':{schema:{$ref:'#/components/schemas/Shared'}}}}},
        '/inventory/private':{post:{operationId:'InventoryApi_privateData',tags:['private'],responses:{'200':{schema:{$ref:'#/components/schemas/Private'}}}}},
    },
    components:{schemas:{
        Shared:{type:'object',properties:{nested:{$ref:'#/components/schemas/Nested'}}},
        Nested:{type:'string'},
        Private:{type:'object',properties:{shared:{$ref:'#/components/schemas/Shared'},secret:{$ref:'#/components/schemas/PrivateNested'}}},
        PrivateNested:{type:'string',description:'private-only-schema'},
    }},
};

@injectable()
class DocumentsController extends DocumentsApi {
    private readonly document: AuthorizedApiDocument;
    constructor(@inject(AuthorizationService) policy: AuthorizationService) {
        super();
        this.document = new AuthorizedApiDocument(policy, [RouteMetadataFactory.create(InventoryApi,'browse'),RouteMetadataFactory.create(InventoryApi,'privateData')]);
    }
    override openapi(_request: object): Promise<ApiDocumentObject> { return this.document.project(catalog); }
}

class DocumentCredentials extends JwtHook<string> {
    adminEnabled = true;
    override async mint(_request: string): Promise<MintedJwt> { throw new Error('not used'); }
    override async parseJwt(token: string): Promise<AuthenticatedCaller> {
        return new AuthenticatedCaller(token, token === 'admin' && this.adminEnabled ? ['inventory-admin'] : []);
    }
}

describe('authenticated served document projection', () => {
    let server: Server;
    let baseUrl: string;
    const credentials = new DocumentCredentials();
    beforeAll(async () => {
        HeaderRegistry.configure([], true);
        const bindings = new ContainerModule((options: ContainerModuleLoadOptions) => options.bind(JWT_HOOK).toConstantValue(credentials));
        const router = await WebpiecesRouterFactory.create({appBindings:[bindings]});
        router.addRoutes(DocumentsApi, DocumentsController);
        const app = express();
        new WebpiecesExpressRouter(router).bindExpress(app);
        server = createServer(app);
        await new Promise<void>((resolve: () => void) => server.listen(0,'127.0.0.1',resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterAll(async () => { await new Promise<void>((resolve: () => void) => server.close(() => resolve())); });

    async function document(token?: string): Promise<Response> {
        const headers: Record<string,string> = {'content-type':'application/json'};
        if (token) headers['authorization'] = `Bearer ${token}`;
        return fetch(`${baseUrl}/documents/openapi`,{method:'POST',headers,body:'{}'});
    }

    it('authenticates the real documentation URL before publishing any schemas', async () => {
        const response = await document();
        expect(response.status).toBe(401);
        expect(await response.text()).not.toContain('private-only-schema');
    });

    it('prunes denied operations, sidebar tags and exclusively private transitive schemas', async () => {
        const response = await document('reader');
        expect(response.status).toBe(200);
        const result = await response.json();
        expect(Object.keys(result.paths)).toEqual(['/inventory/browse']);
        expect(Object.keys(result.components.schemas)).toEqual(['Shared','Nested']);
        expect(result.tags).toEqual([{name:'browse'}]);
        expect(JSON.stringify(result)).not.toContain('private');
    });

    it('recomputes from current policy without a shared user catalog cache', async () => {
        expect(Object.keys((await (await document('admin')).json()).paths)).toHaveLength(2);
        credentials.adminEnabled = false;
        expect(Object.keys((await (await document('admin')).json()).paths)).toEqual(['/inventory/browse']);
        expect(Object.keys(catalog['paths'] as ApiDocumentObject)).toHaveLength(2);
    });
});
