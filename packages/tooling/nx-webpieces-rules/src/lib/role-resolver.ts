/**
 * Role Resolver
 *
 * Determines the `role` field written per project into
 * architecture/dependencies.json — a project's ROLE, orthogonal to its
 * `framework` (libType). Known values:
 *
 *   - `server`       — a runnable server app; DI design roots on `@DocumentDesign`.
 *   - `app`          — a runnable non-HTTP application bootstrapped via
 *                      `container.get(XxxApp)` (e.g. the tooling packages); DI design
 *                      roots on `@DocumentDesign`, drawn exactly like a server.
 *   - `designed-lib` — a library whose DI design we generate; roots on
 *                      `@DocumentDesign` (required to have ≥1).
 *   - `lib`          — a plain library; no DI design is generated.
 *   - `client`       — a client app (e.g. angular-site); angular apps keep their
 *                      component/route design, others get none.
 *   - `api-lib`      — an API-contract library: exports `@ApiPath`/`@Rpc`/`@PubSub`
 *                      abstract `*Api` classes that servers implement and clients
 *                      generate typed clients from. No DI design of its own.
 *
 * Resolution order:
 * 1. Explicit nx tag `role:<value>` on the project (project.json tags) — the
 *    source of truth; every project should carry one (enforced by the
 *    `role-tag` code rule).
 * 2. Fallback: 'lib' (a plain library with no generated design) — the safe
 *    default so an untagged project never claims to be a server/client.
 */

import { ProjectInfo } from './project-info';

export const ROLE_TAG_PREFIX = 'role:';

/** The roles the `role-tag` rule and the DI-graph analyzer understand. */
export const KNOWN_ROLES: ReadonlyArray<string> = ['server', 'app', 'designed-lib', 'lib', 'client', 'api-lib'];

/** Default role for a project with no explicit `role:` tag. */
export const DEFAULT_ROLE = 'lib';

export class RoleResolution {
    constructor(
        /** Resolved role name, or null when resolution failed */
        public readonly role: string | null,
        /** Problem description when resolution failed, otherwise null */
        public readonly problem: string | null
    ) {}
}

export function resolveRole(info: ProjectInfo): RoleResolution {
    const tagValues = info.tags
        .filter((tag: string) => tag.startsWith(ROLE_TAG_PREFIX))
        .map((tag: string) => tag.slice(ROLE_TAG_PREFIX.length).trim());

    if (tagValues.length > 1) {
        return new RoleResolution(
            null,
            `${info.name}: has ${tagValues.length} 'role:' tags (${tagValues.join(', ')}) — a project must have at most one`
        );
    }
    if (tagValues.length === 1) {
        if (tagValues[0].length === 0) {
            return new RoleResolution(null, `${info.name}: 'role:' tag has an empty value`);
        }
        return new RoleResolution(tagValues[0], null);
    }

    return new RoleResolution(DEFAULT_ROLE, null);
}
