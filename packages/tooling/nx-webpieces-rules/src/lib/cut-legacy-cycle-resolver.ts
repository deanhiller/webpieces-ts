/**
 * Cut-Legacy-Cycle Resolver
 *
 * Reads the `cutLegacyCycle:<targetService>` nx tags off a project.json.
 *
 * WHAT THE TAG MEANS — and it is deliberately not flattering. The runtime graph must be acyclic:
 * CD rolls services out in dependency order and a cycle has no such order, so `assignLevels`
 * (runtime-graph-levels.ts) THROWS rather than levelling one. This tag is the escape, and it does
 * NOT claim the edge is harmless. It ADMITS the cycle is real and is being tolerated as LEGACY
 * DEBT — an IOU written into project.json, not a design choice and not an approved pattern. The
 * honest cures come first (retag a node that is not really a deployed service `role:lib`; make the
 * hop asynchronous with `@PubSub()`, whose queued edges are already excluded; extract a shared
 * `role:api-lib` both sides depend on); this is what you write down when none of them fit yet.
 *
 * It is PER-EDGE, not per-project: the tag names the TARGET service, so cutting `a -> b` says
 * nothing about `a -> c`. A blanket project-level exemption would silently disable the check for
 * every future edge that project grows.
 *
 * The edge is still DRAWN. It is stamped `cutLegacyCycle` on the runtime edge and rendered as a
 * dashed red "legacy cycle" arrow — the whole point of the graph is that hops are visible, so an
 * exemption that erased the arrow would hide exactly the debt it is recording.
 *
 * Keep it greppable: `grep -rn cutLegacyCycle` over the repo enumerates every tolerated cycle, which
 * is the reason the tag says out loud what it is rather than hiding behind a neutral name.
 *
 * Resolution order:
 * 1. Every `cutLegacyCycle:<targetService>` tag on the project (project.json tags). A project may
 *    carry several — one per edge it cuts — and each value must be a non-empty service name.
 * 2. Fallback: no cuts, which is the state every project should be in.
 *
 * A tag naming a service NOTHING answers to fails the build; that check needs the resolved runtime
 * nodes and therefore lives in runtime-cycle-cuts.ts, not here.
 */

import { ProjectInfo } from './project-info';

export const CUT_LEGACY_CYCLE_TAG_PREFIX = 'cutLegacyCycle:';

export class CutLegacyCycleResolution {
    constructor(
        /** Target service names this project cuts its runtime edge to, sorted; null when resolution failed. */
        public readonly targets: string[] | null,
        /** Problem description when resolution failed, otherwise null */
        public readonly problem: string | null,
    ) {}
}

// webpieces-disable no-function-outside-class -- pure tag resolver, mirrors the sibling resolveRole/resolveDrawOnGraph
export function resolveCutLegacyCycles(info: ProjectInfo): CutLegacyCycleResolution {
    const values = info.tags
        .filter((tag: string) => tag.startsWith(CUT_LEGACY_CYCLE_TAG_PREFIX))
        .map((tag: string) => tag.slice(CUT_LEGACY_CYCLE_TAG_PREFIX.length).trim());

    if (values.some((value: string) => value.length === 0)) {
        return new CutLegacyCycleResolution(
            null,
            `${info.name}: a 'cutLegacyCycle:' tag has an empty value — it must name the target ` +
                `service whose runtime edge is being cut, e.g. 'cutLegacyCycle:server2'`,
        );
    }
    const unique = Array.from(new Set(values)).sort();
    if (unique.length !== values.length) {
        return new CutLegacyCycleResolution(
            null,
            `${info.name}: has duplicate 'cutLegacyCycle:' tags (${values.join(', ')}) — one tag per ` +
                `target service`,
        );
    }
    return new CutLegacyCycleResolution(unique, null);
}
