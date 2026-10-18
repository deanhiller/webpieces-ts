import { WpAuthorization, AuthorizationType, WpAuth, jwt as jwtAuth } from '@webpieces/core-util';
import { ApiPath, ApiType, Endpoint, MCP, POST, READ, RPC, WpMcpTool } from '@webpieces/core-util';

/*
 * JSDoc links (#1284), resolved to the PUBLISHED identity of what they name. The `Dto` suffix is
 * stripped by the spec's schemaNames, so a link to `MenuDto` must publish `Menu`.
 */

/** When a menu is served. */
export enum MenuKindDto {
    LUNCH = 'lunch',
    DINNER = 'dinner',
}

/** One menu. Its kind is one of {@link MenuKindDto}. */
export interface MenuDto {
    /** The dishes, in the order {@link LinksApi.publishMenu} printed them. */
    items: string[];

    /** When it is served. */
    kind: MenuKindDto;
}

/** Asks for one menu. */
export interface FetchMenuRequestDto {
    /** Which menu; the same id as {@link MenuDto.items | the first dish}'s menu. */
    menuId: string;

    /** The location's code. Mutually exclusive with {@link storeId} — see that field. */
    locationCode?: string;

    /** The store's id. MUTUALLY EXCLUSIVE WITH {@link locationCode | the location}. */
    storeId?: string;
}

/** The menu asked for. */
export interface FetchMenuResponseDto {
    /** The menu. */
    menu: MenuDto;
}

/** Menus. */
@ApiType(MCP)
@ApiPath('/menus')
export abstract class LinksApi {
    /**
     * Reads one menu as a {@link MenuDto}, served at {@link MenuKindDto.LUNCH}. Then call
     * {@link LinksApi.publishMenu | the publish tool} or {@link LinksApi.auditMenu}. See
     * {@link https://example.com/menus | the guide} and {@link https://example.com/raw}.
     *
     * @summary Fetch a menu
     * @returns The {@link MenuDto} asked for.
     */
    @WpMcpTool('fetch_menu')
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/fetch', READ, RPC)
    fetchMenu(_request: FetchMenuRequestDto): Promise<FetchMenuResponseDto> {
        throw new Error('contract only');
    }

    /**
     * Publishes one menu.
     *
     * @summary Publish a menu
     * @returns The published menu.
     */
    @WpMcpTool('publish_menu')
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/publish', READ, RPC)
    publishMenu(_request: FetchMenuRequestDto): Promise<FetchMenuResponseDto> {
        throw new Error('contract only');
    }

    /**
     * Audits one menu. Not a tool.
     *
     * @summary Audit a menu
     * @returns The audited menu.
     */
    @WpAuth([jwtAuth()])
    @WpAuthorization({ authType: AuthorizationType.ALL_USERS })
    @Endpoint(POST, '/audit', READ, RPC)
    auditMenu(_request: FetchMenuRequestDto): Promise<FetchMenuResponseDto> {
        throw new Error('contract only');
    }
}
