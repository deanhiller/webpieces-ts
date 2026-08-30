/**
 * COMPILE-TIME assertions pinning `createRpcClient`'s filters argument to ONE spelling per decision.
 *
 * A CLASS is one shape and cannot express "absent, or at least one" — so the argument is a NON-EMPTY
 * tuple, and the empty array that used to mean the same thing as omitting it is a COMPILE error. See
 * `.claude/review/backwards-compatibility.md` shim shape #1: the fix for two spellings is to make the
 * type unsatisfiable in the bad case, not to document a preference.
 *
 * WHY THIS FILE AND NOT A SPEC. `tsconfig.lib.json` EXCLUDES `*.spec.ts`, and vitest strips types
 * with esbuild rather than checking them — so a `@ts-expect-error` in a spec is inert and the suite
 * passes whether or not the bad case still compiles. Here it is compiled by the build: if any line
 * below ever starts compiling, tsc fails with TS2578 ("Unused '@ts-expect-error' directive"). That
 * failure IS the test. Mirrors `core-util/src/http/AuthJwtCompileAssertions.ts`.
 *
 * Nothing here runs. The class is never constructed and never exported from the barrel.
 */

import { ClientFilterDefinition } from '@webpieces/http-client-core';
import { ClientConfig } from './ClientConfig';
import { ClientHttpFactory } from './ClientHttpFactory';
import { ContextBaseUrlFilter } from './ContextBaseUrlFilter';

/** Stand-in for a real contract; only its TYPE is used, and only by tsc. */
declare const someApi: Parameters<ClientHttpFactory['createRpcClient']>[0];
declare const factory: ClientHttpFactory;

class CreateRpcClientCompileAssertions {
    /** ✅ No app filters — the ONE spelling for it is omitting the argument. */
    noFilters(): void {
        factory.createRpcClient(someApi, new ClientConfig('server2'));
    }

    /** ✅ One app filter. */
    oneFilter(): void {
        factory.createRpcClient(someApi, new ClientConfig('partner-webhooks'), [
            new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
        ]);
    }

    /** ✅ Several app filters. */
    severalFilters(): void {
        factory.createRpcClient(someApi, new ClientConfig('partner-webhooks'), [
            new ClientFilterDefinition(1000, new ContextBaseUrlFilter()),
            new ClientFilterDefinition(500, new ContextBaseUrlFilter()),
        ]);
    }

    /**
     * ❌ `[]` is a SECOND way to say what omitting the argument already says. Deleting it by type is
     * what keeps "this client has no app filters" to one spelling.
     */
    emptyArrayDoesNotCompile(): void {
        // @ts-expect-error - pass no third argument instead; [] is a second spelling of that
        factory.createRpcClient(someApi, new ClientConfig('server2'), []);
    }
}

void CreateRpcClientCompileAssertions;
