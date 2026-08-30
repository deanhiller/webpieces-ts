import { RuleFailError, Option } from '@webpieces/rules-config';
import { sortGraphTopologically } from './graph-sorter';
import type { GraphEntry, EnhancedGraph } from './graph-sorter';
import { ProjectCycleDetector, ProjectCycle } from './graph-cycles';
import { CUT_LEGACY_CYCLE_TAG_PREFIX } from './cut-legacy-cycle-resolver';
import { RUNTIME_RULE_NAME } from './runtime-config';
import type { RuntimeEdge, RuntimeGraph } from './runtime-graph-model';

/**
 * LEVELS and ADJACENCY for the runtime graph — how deep each service sits, and who calls whom.
 *
 * Its own module rather than a block inside runtime-graph.ts: that file owns DERIVATION (turning
 * apiRelations into services, apis, edges, queues and triggers), and this is a pure graph
 * computation over the result, with no knowledge of contracts at all. Splitting it also keeps
 * runtime-graph.ts under the file-size limit, which is the visible symptom of the same thing.
 */
/**
 * Adjacency (service -> [targets]) used for leveling + cycle checks.
 *
 * TWO KINDS OF EDGE ARE EXCLUDED, and the second is modelled on the first:
 *
 * PUBSUB EDGES. A queue is precisely the thing that decouples producer from consumer: the producer
 * returns as soon as the task is enqueued and never waits on the consumer, so a queued hop is not a
 * runtime dependency in the sense levels and cycle detection mean. Counting them would make the
 * common and correct `A → queue → A` (a service deferring its own work) an architecture cycle, and
 * would rank services by an ordering that does not constrain deploy or startup.
 *
 * EDGES STAMPED `cutLegacyCycle`. The calling project carries a `cutLegacyCycle:<target>` nx tag
 * (see cut-legacy-cycle-resolver.ts) ADMITTING that this hop closes a real cycle which is being
 * tolerated as legacy debt. Unlike a queued hop the coupling is real, so the edge is still drawn —
 * it is only kept out of leveling and cycle detection, which are the two things a cycle makes
 * meaningless.
 */
// webpieces-disable no-function-outside-class -- pure graph helper, matches the sibling helpers in this file
export function adjacencyFromEdges(
    serviceNames: string[],
    edges: RuntimeEdge[],
): Record<string, string[]> {
    const adj: Record<string, string[]> = {};
    for (const name of serviceNames) adj[name] = [];
    for (const edge of edges) {
        if (edge.type === 'pubsub') continue;
        if (edge.cutLegacyCycle === true) continue;
        if (!adj[edge.from]) adj[edge.from] = [];
        adj[edge.from].push(edge.to);
    }
    return adj;
}

/**
 * Stamp `cutLegacyCycle` on every runtime edge a project declared a cut for — the DECLARATION
 * (`cutLegacyCycle:<targetService>` nx tags, resolved into `GraphEntry.cutLegacyCycle` and committed
 * to dependencies.json) turned into the mark {@link adjacencyFromEdges} above reads.
 *
 * IT FAILS THE BUILD ON A TAG THAT CUTS NOTHING, in both directions:
 *
 *  - the tag names a service no runtime node answers to — a typo or a rename. Silently doing nothing
 *    is the worst outcome available: the check would look exempted while no edge was in fact cut, or
 *    the tag would keep reading as a live IOU after the service it named was deleted. `serviceName`
 *    is validated against real module names for exactly this reason.
 *  - the tag resolves, but there is no direct edge to cut. The debt is PAID — delete the tag, so
 *    `grep -rn cutLegacyCycle` keeps enumerating only cycles still actually tolerated.
 *
 * Returned as problems (the deriver's `problems` list) rather than thrown, so one run names every
 * bad tag instead of stopping at the first.
 *
 * @param edges       the derived runtime edges, mutated in place.
 * @param projects    the committed project entries carrying `cutLegacyCycle`.
 * @param nodeByServiceName addressable name -> runtime node, the SAME map that resolves a call
 *                          target, so a tag may name a module name or a declared serviceName.
 */
// webpieces-disable no-function-outside-class -- pure pass over derived edges, sibling of the helpers here
export function applyCycleCuts(
    edges: RuntimeEdge[],
    projects: EnhancedGraph,
    nodeByServiceName: Map<string, string>,
): string[] {
    const problems: string[] = [];
    for (const name of Object.keys(projects).sort()) {
        const entry: GraphEntry = projects[name];
        for (const target of entry.cutLegacyCycle ?? []) {
            const node = nodeByServiceName.get(target);
            if (node === undefined) {
                problems.push(
                    `${name} declares ${CUT_LEGACY_CYCLE_TAG_PREFIX}${target}, but no runtime service ` +
                        `answers to '${target}'. Fix the name or delete the tag — a cut that names ` +
                        `nothing exempts nothing.`,
                );
                continue;
            }
            // A queued hop is already excluded from leveling, so it can never be part of a cycle and
            // never needs cutting; only a direct call edge is cuttable.
            const cut = edges.filter(
                (e: RuntimeEdge) => e.from === name && e.to === node && e.type !== 'pubsub',
            );
            if (cut.length === 0) {
                problems.push(
                    `${name} declares ${CUT_LEGACY_CYCLE_TAG_PREFIX}${target}, but it has no direct ` +
                        `runtime call edge to '${node}'. The debt is paid — delete the tag.`,
                );
                continue;
            }
            for (const e of cut) e.cutLegacyCycle = true;
        }
    }
    return problems;
}

/** Adjacency (service -> [targets]) from a loaded runtime graph. */
// webpieces-disable no-function-outside-class -- pure graph helper, sibling of the one above
export function runtimeAdjacency(graph: RuntimeGraph): Record<string, string[]> {
    return adjacencyFromEdges(Object.keys(graph.services), graph.runtimeEdges);
}

/** The cures for a cyclic runtime graph, honest ones first and the IOU last. */
// webpieces-disable no-function-outside-class -- cure list for the throw below, sibling of the helpers in this file
function cycleCures(): Option[] {
    return [
        new Option(
            'Retag a node that is not really a deployed service. A project tagged `role:server` in ' +
                'its project.json that is in fact a library should carry `role:lib` instead, which ' +
                'takes it out of the runtime graph entirely and removes every edge through it.',
            true,
        ),
        new Option(
            'Make the hop asynchronous. A contract marked `@PubSub()` is delivered through a Cloud ' +
                'Tasks queue, and queued edges are excluded from leveling and cycle detection ' +
                'because the producer returns without waiting on the consumer.',
        ),
        new Option(
            'Extract the shared contract into a `role:api-lib` project that both sides depend on, ' +
                'so the call runs in one direction only.',
        ),
        new Option(
            'Last resort — admit the debt. Add `' +
                CUT_LEGACY_CYCLE_TAG_PREFIX +
                '<targetService>` to the CALLING project\'s project.json tags, naming the service on ' +
                'the other end of the one edge you are cutting. This does NOT say the edge is ' +
                'harmless; it records that the cycle is real and is being tolerated as legacy debt. ' +
                'The edge stays on the drawing as a dashed "legacy cycle" arrow, and ' +
                '`grep -rn cutLegacyCycle` enumerates every one still outstanding.',
        ),
    ];
}

/**
 * Assign levels via topological sort — and THROW on a cycle rather than levelling one.
 *
 * This used to swallow the cycle and flatten EVERY service to level 0, which was the worst available
 * outcome twice over: one bad edge anywhere silently restratified the whole graph, and the reason
 * was discarded, so the diagram rendered as one legitimate-looking flat row.
 *
 * Cycles are not allowed. CD deploys services in dependency order, and a cyclic architecture has no
 * such order — whichever member rolls out first is calling one that is not up yet — so the graph is
 * not deployable and its level numbers mean nothing.
 *
 * Detection is {@link ProjectCycleDetector}, the ONE cycle detector in this package (it guards the
 * compile-time project graph too); only the audience and the cures differ, so only the message is
 * written here.
 */
// webpieces-disable no-function-outside-class -- pure graph helper, sibling of the two above
export function assignLevels(adjacency: Record<string, string[]>): Record<string, number> {
    const cycles = new ProjectCycleDetector().find(adjacency);
    if (cycles.length > 0) {
        const listed = cycles.map((cycle: ProjectCycle): string => `  ${cycle.describe()}`).join('\n');
        const plural = cycles.length === 1 ? 'cycle' : 'cycles';
        throw new RuleFailError(
            RUNTIME_RULE_NAME,
            `The runtime service graph contains ${cycles.length} ${plural}:\n${listed}\n` +
                'CD deploys services in dependency order and a cycle has no such order — whichever ' +
                'service in the chain rolls out first calls one that is not up yet — so an ' +
                'architecture with cycles cannot be deployed and its level numbers are meaningless. ' +
                'Cut every chain above.',
            undefined,
            undefined,
            cycleCures(),
        );
    }
    const levels: Record<string, number> = {};
    const sorted = sortGraphTopologically(adjacency);
    for (const name of Object.keys(sorted)) levels[name] = sorted[name].level;
    return levels;
}
