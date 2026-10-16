/* eslint-disable */
import { ApiPath, AuthorizationType, Endpoint, POST, READ, RPC, WpAuthorization, WpAuthPublic } from '@webpieces/core-util';

export enum ShadeDto {
    LIGHT = 'light',
    DARK = 'dark',
}

/** A paint by name. */
export interface NamedPaintDto {
    /** Discriminates this branch. */
    kind: 'named';
    /** The paint's name. */
    name: string;
}

/** A paint by shade. */
export interface ShadedPaintDto {
    /** Discriminates this branch. */
    kind: 'shaded';
    /** The shade. */
    shade: ShadeDto;
}

export type PaintDto = NamedPaintDto | ShadedPaintDto;

export class PaintRequest {
    /** The paint to use. */
    paint!: PaintDto;
}

/** What was painted. */
export class PaintResponse {
    /** How many walls. */
    walls!: number;
}

/** Painting: an undocumented enum, union alias and class, all named in one refusal. */
@ApiPath('/paint')
export class UndocumentedApi {
    /**
     * Paints a wall.
     *
     * @returns How many walls were painted.
     */
    @Endpoint(POST, '/wall', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    wall(request: PaintRequest): Promise<PaintResponse> {
        throw new Error('contract');
    }
}
