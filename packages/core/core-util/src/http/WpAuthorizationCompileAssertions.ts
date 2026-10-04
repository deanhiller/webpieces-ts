import { AuthorizationType, WpAuthorization } from './authorization';

class OrderPolicy {
    permission!: 'orders:read' | 'orders:edit';
}

WpAuthorization({ authType: AuthorizationType.ALL_USERS });
WpAuthorization({ authType: AuthorizationType.ROLES, roles: ['editor'] });
WpAuthorization<OrderPolicy>({ authType: AuthorizationType.CUSTOM, appPolicy: { permission: 'orders:edit' } });
// @ts-expect-error ROLES requires a nonempty tuple
WpAuthorization({ authType: AuthorizationType.ROLES, roles: [] });
// @ts-expect-error ROLES requires explicit roles
WpAuthorization({ authType: AuthorizationType.ROLES });
// @ts-expect-error CUSTOM requires typed application policy
WpAuthorization<OrderPolicy>({ authType: AuthorizationType.CUSTOM });
// @ts-expect-error standard policies reject application policy
WpAuthorization<OrderPolicy>({ authType: AuthorizationType.ALL_USERS, appPolicy: { permission: 'orders:edit' } });
// @ts-expect-error roles are accepted only by ROLES
WpAuthorization({ authType: AuthorizationType.SERVICE_ONLY, roles: ['editor'] });
// @ts-expect-error arbitrary top-level permissions belong in CUSTOM.appPolicy
WpAuthorization({ authType: AuthorizationType.ALL_USERS, permission: 'orders:read' });
// @ts-expect-error the application payload is checked by its declared type
WpAuthorization<OrderPolicy>({ authType: AuthorizationType.CUSTOM, appPolicy: { permission: 'users:edit' } });
// @ts-expect-error anonymous access requires a reason
WpAuthorization({ authType: AuthorizationType.ANONYMOUS });
