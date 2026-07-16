import { injectable, bindingScopeValues } from 'inversify';

/**
 * GreetingService - a trivial business-logic service that exists purely to PROVE
 * inject-by-type works end-to-end with a SINGLE decorator and no Symbol token.
 *
 * `@injectable(bindingScopeValues.Singleton)` both marks the class injectable (so Inversify v7
 * reads its constructor `design:paramtypes`) AND records singleton scope. With the app container
 * in autobind mode, the class self-binds on first resolve — no `@provideSingleton`, no `@inject`.
 * {@link Server2Controller} declares a `GreetingService` param and it resolves by concrete type.
 */
@injectable(bindingScopeValues.Singleton)
export class GreetingService {
    greet(name: string | undefined): string {
        return `Hello, ${name ?? 'anonymous'}! (from GreetingService via inject-by-type)`;
    }
}
