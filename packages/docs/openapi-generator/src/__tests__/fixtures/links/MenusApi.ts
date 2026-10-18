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

/** When a menu is served. */
export enum MenuKindDto {
    LUNCH = 'lunch',
    DINNER = 'dinner',
}

/** One menu. Its kind is one of {@link MenuKindDto}. */
export class MenuDto {
    /** The dishes, in the order {@link MenusApi.publishMenu} printed them. */
    items!: string[];

    /** When it is served. */
    kind!: MenuKindDto;
}

/** Where a menu is served. A base the request flattens in — never published on its own. */
export class MenuScopeDto {
    /** The region the menu is served in. */
    region!: string;
}

/** Asks for one menu. */
export class FetchMenuRequestDto extends MenuScopeDto {
    /** Which menu; the same id as {@link MenuDto.items | the first dish}'s menu. */
    menuId!: string;

    /** The location's code. Mutually exclusive with {@link storeId} — see that field. */
    locationCode?: string;

    /**
     * The store's id. MUTUALLY EXCLUSIVE WITH {@link locationCode}: sending both is a `400`. Must lie
     * in {@link region}; compare {@link FetchMenuRequestDto.menuId}.
     */
    storeId?: string;
}

/** The menu asked for. */
export class FetchMenuResponseDto {
    /** The menu. */
    menu!: MenuDto;
}

/** Menus, and the operations that read and publish them (#1284). */
@ApiPath('/menus')
@ApiType(SVC_TO_SVC, EXTERNAL_CUSTOMER, MCP)
export class MenusApi {
    /**
     * Reads one menu as a {@link MenuDto}, served at {@link MenuKindDto.LUNCH}. Then call
     * {@link MenusApi.publishMenu | the publish operation}. See
     * {@link https://example.com/menus | the guide}.
     *
     * @summary Fetch a menu
     * @returns The {@link MenuDto} asked for.
     */
    @Endpoint(POST, '/fetch', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('fetch_menu')
    fetchMenu(request: FetchMenuRequestDto): Promise<FetchMenuResponseDto> {
        throw new Error('contract');
    }

    /**
     * Publishes one menu, as {@link MenusApi.fetchMenu} reads it.
     *
     * @summary Publish a menu
     * @returns The published menu.
     */
    @Endpoint(POST, '/publish', READ, RPC)
    @WpAuthPublic('Fixture only.')
    @WpAuthorization({ authType: AuthorizationType.ANONYMOUS, reason: 'Fixture only.' })
    @WpMcpTool('publish_menu')
    publishMenu(request: FetchMenuRequestDto): Promise<FetchMenuResponseDto> {
        throw new Error('contract');
    }
}
