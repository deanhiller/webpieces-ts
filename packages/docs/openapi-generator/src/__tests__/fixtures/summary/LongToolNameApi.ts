/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    MCP,
    POST,
    READ,
    RPC,
    WpAuthorization,
    WpAuthPublic,
    WpMcpTool,
} from '@webpieces/core-util';

/** Which barrel to address. */
export class BarrelRequest {
    /** The barrel's identifier. */
    barrelId!: string;
}

/** One barrel. */
export class BarrelResponse {
    /** How full the barrel is, in litres. */
    litres!: number;
}

/**
 * Agent tools whose names the Claude Connectors Directory would refuse (#1296). The generator reads
 * this file through the compiler and never executes it, so `@WpMcpTool`'s own decoration-time check
 * never runs here: the GENERATOR is what must refuse them.
 */
@ApiPath('/barrels')
@ApiType(MCP)
export class LongToolNameApi {
    /**
     * Measures one barrel.
     *
     * @summary Measure a barrel
     * @returns The barrel and its level.
     */
    @Endpoint(POST, '/measure', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('measure_one_barrel_in_the_cellar_and_report_its_level_in_litres_now')
    measure(request: BarrelRequest): Promise<BarrelResponse> {
        throw new Error('contract');
    }

    /**
     * Taps one barrel.
     *
     * @summary Tap a barrel
     * @returns The barrel after tapping.
     */
    @Endpoint(POST, '/tap', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('barrels.tap')
    tap(request: BarrelRequest): Promise<BarrelResponse> {
        throw new Error('contract');
    }
}
