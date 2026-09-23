import { describe, it, expect } from 'vitest';
import 'reflect-metadata';
import { ApiPath, Endpoint, POST, READ, RPC, WpAuthPublic } from '../decorators';
import {
    ApiType,
    assertApiTypeMatchesMcpTools,
    EXTERNAL_CUSTOMER,
    getApiTypes,
    MCP,
    SVC_TO_SVC,
} from '../api-type';
import {
    InvalidEndpointForMcp,
    getInvalidEndpointsForMcp,
    WpMcpTool,
} from '../../mcp/McpMetadata';

/** The reason both measured cases share: the type is CORRECT and the exclusion is permanent. */
const TRANSPORT_REASON =
    'a transport envelope body is opaque by design; the published partner contract for each event ' +
    'type owns its shape';

/**
 * `@ApiType` decides WHICH generated documents a contract feeds, and the two things worth pinning are
 * the fail-closed default and the MCP biconditional.
 *
 * The default is the whole reason this is a named list rather than a `hidden` boolean: a contract
 * whose author typed nothing about who reads it must reach nobody but us. The biconditional is what
 * stops MCP membership being declared in two places that can disagree.
 */
class Request {
    id!: string;
}

class Response {
    ok!: boolean;
}

@ApiPath('/declared')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER)
class DeclaredApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/silent')
class SilentApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/claims-mcp')
@ApiType(SVC_TO_SVC, MCP)
class ClaimsMcpWithoutToolApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/tool-without-mcp')
@ApiType(SVC_TO_SVC)
class ToolWithoutMcpApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    @WpMcpTool('go')
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/agrees')
@ApiType(SVC_TO_SVC, MCP)
class AgreesApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    @WpMcpTool('go')
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/mixed-mcp')
@ApiType(SVC_TO_SVC, MCP)
class MixedMcpApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    @WpMcpTool('go')
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }

    @Endpoint(POST, '/fanout', READ, RPC)
    @WpAuthPublic('Test fixture.')
    @InvalidEndpointForMcp(TRANSPORT_REASON)
    fanout(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/contradicts')
@ApiType(SVC_TO_SVC, MCP)
class ContradictsApi {
    @Endpoint(POST, '/go', READ, RPC)
    @WpAuthPublic('Test fixture.')
    @WpMcpTool('go')
    @InvalidEndpointForMcp(TRANSPORT_REASON)
    go(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

@ApiPath('/all-excluded')
@ApiType(SVC_TO_SVC, MCP)
class AllExcludedApi {
    @Endpoint(POST, '/fanout', READ, RPC)
    @WpAuthPublic('Test fixture.')
    @InvalidEndpointForMcp(TRANSPORT_REASON)
    fanout(request: Request): Promise<Response> {
        throw new Error('contract');
    }
}

describe('@ApiType', () => {
    it('records what a contract declared, in declaration order', () => {
        expect(getApiTypes(DeclaredApi)).toEqual([SVC_TO_SVC, EXTERNAL_CUSTOMER]);
    });

    it('DEFAULTS to SVC_TO_SVC alone — a contract that says nothing reaches nobody but us', () => {
        // This is the fail-closed half of the design. A default that included EXTERNAL_CUSTOMER
        // would publish a contract whose author typed nothing about who reads it.
        expect(getApiTypes(SilentApi)).toEqual([SVC_TO_SVC]);
        expect(getApiTypes(SilentApi)).not.toContain(EXTERNAL_CUSTOMER);
    });
});

describe('MCP membership has exactly ONE spelling', () => {
    it('REJECTS MCP with no @WpMcpTool, naming the cure', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the assertion
        expect(() => assertApiTypeMatchesMcpTools(ClaimsMcpWithoutToolApi)).toThrow(
            /declares @ApiType\(\.\.\., MCP\) but no method carries @WpMcpTool/,
        );
    });

    it('REJECTS a @WpMcpTool on a contract that does not declare MCP', () => {
        // Declared in two places, the two can disagree — and each declaration is individually valid,
        // so the disagreement is invisible without this.
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the assertion
        expect(() => assertApiTypeMatchesMcpTools(ToolWithoutMcpApi)).toThrow(
            /does not declare @ApiType\(\.\.\., MCP\)/,
        );
    });

    it('accepts a contract where the two AGREE', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- asserting it does NOT throw
        expect(() => assertApiTypeMatchesMcpTools(AgreesApi)).not.toThrow();
    });

    it('accepts a contract that declares neither', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- asserting it does NOT throw
        expect(() => assertApiTypeMatchesMcpTools(DeclaredApi)).not.toThrow();
    });
});

describe('@InvalidEndpointForMcp — permanently outside MCP, with the reason', () => {
    it('REFUSES an empty reason at decoration time, because the reason IS the declaration', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the assertion
        expect(() => InvalidEndpointForMcp('   ')).toThrow(/requires a non-empty reason/);
    });

    it('records the method and its reason, which is what makes the grep worth running', () => {
        expect(getInvalidEndpointsForMcp(MixedMcpApi)).toEqual([
            { methodName: 'fanout', reason: TRANSPORT_REASON },
        ]);
    });

    it('sits OUTSIDE the biconditional — a contract with one tool and one exclusion is fine', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- asserting it does NOT throw
        expect(() => assertApiTypeMatchesMcpTools(MixedMcpApi)).not.toThrow();
    });

    it('REJECTS @WpMcpTool on the same method — the two contradict each other', () => {
        // Resolving it either way would make the pair a second spelling of one decision, and half
        // the readers of that method would be wrong about what it does.
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the assertion
        expect(() => assertApiTypeMatchesMcpTools(ContradictsApi)).toThrow(
            /carries BOTH @WpMcpTool and @InvalidEndpointForMcp on go/,
        );
    });

    it('REJECTS a contract declaring MCP where EVERY endpoint is excluded', () => {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS the assertion
        expect(() => assertApiTypeMatchesMcpTools(AllExcludedApi)).toThrow(
            /EVERY endpoint on it is @InvalidEndpointForMcp/,
        );
    });
});
