/* eslint-disable */
import {
    ApiPath,
    ApiType,
    AuthorizationType,
    Endpoint,
    EXTERNAL_CUSTOMER,
    MCP,
    POST,
    READ,
    RPC,
    SVC_TO_SVC,
    WpAuthorization,
    WpAuthPublic,
    WpMcpTool,
} from '@webpieces/core-util';

/*
 * #1292 rule 1: every `@privateRemarks` below carries the word SECRET-NOTE, and the spec asserts the
 * word appears in NO file the run writes — OpenAPI, bundled, MCP document, MCP tool catalog.
 */

/**
 * How bright a lamp is.
 *
 * @privateRemarks SECRET-NOTE on an enum.
 */
export enum BrightnessDto {
    DIM = 'dim',
    BRIGHT = 'bright',
}

/**
 * A lamp switched by colour.
 *
 * @privateRemarks SECRET-NOTE on a union branch.
 */
export interface ColourSwitchDto {
    /** Discriminates this branch. */
    kind: 'colour';
    /**
     * The colour to switch to.
     *
     * @privateRemarks SECRET-NOTE on a field of a union branch.
     */
    colour: string;
}

/** A lamp switched by brightness. */
export interface BrightnessSwitchDto {
    /** Discriminates this branch. */
    kind: 'brightness';
    /** The brightness to switch to. */
    brightness: BrightnessDto;
}

/**
 * Either way of switching a lamp.
 *
 * @privateRemarks SECRET-NOTE on a union alias.
 */
export type LampSwitchDto = ColourSwitchDto | BrightnessSwitchDto;

/**
 * Which lamp to switch, and how.
 *
 * @privateRemarks SECRET-NOTE on a request class.
 */
export class SwitchLampRequest {
    /**
     * The lamp's identifier.
     *
     * @privateRemarks SECRET-NOTE on a field.
     */
    lampId!: string;

    /** How to switch it. */
    change!: LampSwitchDto;
}

/** The lamp after the switch. */
export class SwitchLampResponse {
    /** The brightness it now has. */
    brightness!: BrightnessDto;
}

/**
 * Lamps in a room.
 *
 * @privateRemarks SECRET-NOTE on a contract, which is the tag description.
 */
@ApiPath('/lamps')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class PrivateRemarksApi {
    /**
     * Switches one lamp.
     *
     * @summary Switch a lamp
     * @returns The lamp after the switch.
     * @privateRemarks SECRET-NOTE on a method, between the returns and mcp tags.
     * @mcp Switch exactly the lamp the user named.
     */
    @Endpoint(POST, '/switch', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('switch_lamp')
    switchLamp(request: SwitchLampRequest): Promise<SwitchLampResponse> {
        throw new Error('contract');
    }
}
