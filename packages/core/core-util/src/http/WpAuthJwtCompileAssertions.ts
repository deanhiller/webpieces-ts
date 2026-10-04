import { getAuthMeta, WpAuth } from './decorators';
import { jwt } from './auth-mode';
// @ts-expect-error standalone JWT declarations are removed; use WpAuth([jwt()]) plus WpAuthorization
import { WpAuthJwt, getAuthMode, rolesRequired } from './decorators';

/** Type assertions run in the library build because vitest erases types. */
export class AuthJwtCompileAssertions {
    legitimate(): void {
        void WpAuth([jwt()]);
    }

    rejected(): void {
        // @ts-expect-error a protected declaration requires at least one credential descriptor
        void WpAuth([]);
        // @ts-expect-error policy belongs on WpAuthorization
        void jwt({ roles: ['admin'] });
        // @ts-expect-error method metadata cannot be read without the method name
        void getAuthMeta(AuthJwtCompileAssertions);
        void WpAuthJwt;
        void getAuthMode;
        void rolesRequired;
    }
}
