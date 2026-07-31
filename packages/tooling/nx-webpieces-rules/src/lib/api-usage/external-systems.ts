/**
 * External system declarations
 *
 * A system OUTSIDE this repo that a service talks to — a database, a bucket, a cache. Until now
 * every one of them collapsed into the same grey dashed box, so `lib-firestore` (a datastore) was
 * indistinguishable from an HTTP service the repo happens not to implement. Declaring what a system
 * IS lets the runtime viz draw it as the thing it is.
 *
 * Split out of api-scanner.ts and runtime-graph.ts (both already at their file-size limit) so the
 * two halves of the feature — DECLARING a system and RESOLVING it to arrows — sit together.
 *
 * The two declaration sites exist because the two real cases differ in whether a contract exists:
 *
 *  - **wrapped** — the repo has a vendor seam (`FirestoreAdminApi`), so the kind is declared with an
 *    `@externalSystem <kind> [label]` JSDoc tag on the CONTRACT. A TS `interface` cannot carry a
 *    decorator, and these seams are interfaces, so JSDoc is the only marker that fits in place.
 *  - **unwrapped** — the service opens the connection itself (a `pg.Pool`, a TypeORM `DataSource`)
 *    and there is no contract to mark, so the declaration is an `external:<kind>:<identity>` nx tag
 *    on that PROJECT. Wrapping such a datastore purely to gain a marker is not worth it: a TypeORM
 *    facade never closes, unlike the ~8 hand-picked methods a firestore seam needs.
 *
 * Both resolve to the same `(kind, identity)` pair, and identity is the NODE identity — two projects
 * declaring `postgres` converge on one cylinder with an arrow each, rather than drawing a database
 * apiece.
 */

import type { ApiClassInfo, ExternalSystemDecl, ExternalSystemDecls, ExternalSystemKind } from './api-relations';
import { isExternalSystemKind } from './api-relations';
import type { ProjectInfo } from '../project-info';
import type { RuntimeExternalSystem, RuntimeGraph, RuntimeService } from '../runtime-graph-model';

/** nx tag prefix declaring an external system: `external:<kind>:<identity>`. */
const EXTERNAL_TAG_PREFIX = 'external:';

/** The two halves of a parsed `external:<kind>:<identity>` nx tag. */
class ExternalTag {
    constructor(
        public readonly kind: ExternalSystemKind,
        public readonly identity: string,
    ) {}
}

/**
 * `external:<kind>:<identity>` -> its parts, or null for any other tag.
 *
 * Returns null (rather than throwing) on an unknown kind: this prefix shares a tag list with
 * `framework:` and `role:`, and hard-failing the whole graph generation over one malformed tag is a
 * worse outcome than not drawing one node.
 */
// webpieces-disable no-function-outside-class -- pure parser, matching the sibling builders in this file
function parseExternalTag(tag: string): ExternalTag | null {
    if (!tag.startsWith(EXTERNAL_TAG_PREFIX)) return null;
    const parts = tag.slice(EXTERNAL_TAG_PREFIX.length).split(':');
    if (parts.length !== 2) return null;
    const kind = parts[0].toLowerCase();
    const identity = parts[1].trim();
    if (!isExternalSystemKind(kind) || identity === '') return null;
    return new ExternalTag(kind, identity);
}

/**
 * The committed `externalSystems` table for architecture/dependencies.json, merging both declaration
 * sites into one identity-keyed map.
 *
 * A system may legitimately carry both: a repo can wrap a datastore behind a contract in one service
 * and open it directly in another. Takes the api index rather than the whole scan result so this
 * module never has to import api-scanner, which imports it.
 */
// webpieces-disable no-function-outside-class -- table builder, mirrors buildApiContracts in api-scanner.ts
export function buildExternalSystems(
    apiIndex: Map<string, ApiClassInfo>,
    projectInfos: Map<string, ProjectInfo>,
): ExternalSystemDecls {
    const systems: ExternalSystemDecls = {};
    // First declaration wins the kind, so a later typo cannot silently reshape an already-drawn node.
    const ensure = (identity: string, kind: ExternalSystemKind, label: string): ExternalSystemDecl => {
        if (systems[identity] === undefined) systems[identity] = { kind, label, apis: [], projects: [] };
        return systems[identity];
    };

    for (const api of [...apiIndex.keys()].sort()) {
        const declared = apiIndex.get(api)!.externalSystem;
        if (declared === undefined) continue;
        ensure(declared.label, declared.kind, declared.label).apis.push(api);
    }

    for (const name of [...projectInfos.keys()].sort()) {
        for (const tag of projectInfos.get(name)!.tags) {
            const parsed = parseExternalTag(tag);
            if (parsed === null) continue;
            ensure(parsed.identity, parsed.kind, parsed.identity).projects.push(name);
        }
    }
    return systems;
}

/**
 * Resolve declarations into drawable nodes: which services actually get an arrow to each system.
 *
 * Two resolutions, matching the two declaration sites. A CONTRACT-declared system is reached by
 * every service that `uses` one of its contracts, so the arrows follow real call sites. A
 * TAG-declared system is reached ONLY by the tagged project itself — a tag asserts "I open this
 * connection", and fanning it out to dependents would invent arrows nobody wrote (a service that
 * depends on the entity library only for a DTO type does not talk to the database).
 *
 * A system nothing reaches is dropped rather than drawn floating: a declaration whose users all
 * disappeared is stale, and an unconnected node on the graph reads as a live dependency.
 */
// webpieces-disable no-function-outside-class -- pure resolver, matching the sibling builders in this file
export function resolveExternalSystems(
    decls: ExternalSystemDecls,
    services: Record<string, RuntimeService>,
): Record<string, RuntimeExternalSystem> {
    const out: Record<string, RuntimeExternalSystem> = {};
    for (const identity of Object.keys(decls).sort()) {
        const decl = decls[identity];
        const usedBy = new Set<string>();
        for (const name of Object.keys(services)) {
            if (services[name].uses.some((api: string) => decl.apis.includes(api))) usedBy.add(name);
        }
        // Only when the tagged project is itself a runtime node — tagging a plain library would
        // otherwise draw an arrow leaving a box that does not exist on this graph.
        for (const project of decl.projects) {
            if (services[project] !== undefined) usedBy.add(project);
        }
        if (usedBy.size === 0) continue;
        out[identity] = {
            kind: decl.kind,
            label: decl.label,
            usedBy: [...usedBy].sort(),
            apis: [...decl.apis].sort(),
        };
    }
    return out;
}

/**
 * Hang the resolved systems off the graph, and STAMP each declaring contract with its declaration.
 *
 * The stamp is what stops the same system being drawn twice: the visualizer skips an
 * `unresolvedUses` entry whose contract carries one, because that contract has already been drawn
 * with a real shape rather than as the generic grey box it would otherwise fall back to.
 *
 * A graph with nothing declared is left completely untouched — no empty key is written — so a repo
 * that adopts none of this keeps a byte-identical runtime-dependencies.json.
 */
// webpieces-disable no-function-outside-class -- pure graph mutator, matching the sibling builders in this file
export function attachExternalSystems(graph: RuntimeGraph, systems: Record<string, RuntimeExternalSystem>): void {
    if (Object.keys(systems).length === 0) return;
    graph.externalSystems = systems;
    for (const system of Object.values(systems)) {
        for (const api of system.apis) {
            const entry = graph.apis[api];
            if (entry !== undefined) entry.externalSystem = { kind: system.kind, label: system.label };
        }
    }
}
