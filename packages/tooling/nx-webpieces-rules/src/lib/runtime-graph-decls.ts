/**
 * What the dependsOn CLOSURE WALK accumulates for one runtime node, and the result it produces.
 *
 * A node's effective facts are never just its own: a library that registers routes or builds
 * clients runs inside the server that embeds it, so both its api relations AND the webpieces
 * runtime packages it declares belong to that server. RelationSink is the accumulator for one such
 * walk (see RuntimeGraphDeriver.collectEffectiveRelations); ScanDecl is what it settles into.
 *
 * Split out of runtime-graph.ts so the deriver file holds the derivation and this one holds what
 * the derivation collects.
 */

import type { ApiRef } from './api-usage/api-relations';

/** One project's implements/uses at api-CLASS granularity, from dependencies.json apiRelations. */
export interface ScanDecl {
    name: string;
    implementsApis: ApiRef[];
    usesApis: ApiRef[];
    /** apiClassName -> the embedded LIBRARY project that declared the implements (never the node itself). */
    implementsVia: Map<string, string>;
    /**
     * Marker package -> the project in this node's closure that declared it (the node itself, or a
     * library it embeds). Empty means nothing in the closure speaks the webpieces runtime.
     */
    markerVia: Map<string, string>;
}

/**
 * Accumulates one node's effective relations while its dependsOn closure is walked, keeping the
 * PROVENANCE the walk would otherwise throw away: which library contributed an implements, and
 * which api-lib owns each contract.
 */
export class RelationSink {
    readonly implementsApis: ApiRef[] = [];
    readonly usesApis: ApiRef[] = [];
    readonly implementsVia = new Map<string, string>();
    /** Marker package -> the project in the closure that declared it. See ScanDecl.markerVia. */
    readonly markerVia = new Map<string, string>();

    constructor(
        /** The runtime node these relations are attributed to. */
        private readonly node: string,
    ) {}

    /**
     * Record the webpieces runtime packages `from` declares. Accumulated on the SAME walk as the
     * relations because participation is the same transitive question: a server whose entire
     * webpieces stack arrives through a shared bootstrap library speaks the runtime just as much
     * as one that declares http-routing itself.
     */
    addMarkers(markers: string[] | undefined, from: string): void {
        if (markers === undefined) return;
        // First declarer wins, matching implementsVia's keep-the-first rule.
        for (const marker of markers)
            if (!this.markerVia.has(marker)) this.markerVia.set(marker, from);
    }

    /** `from` is the project whose apiRelations declared this — the node itself, or a lib it embeds. */
    addImplements(ref: ApiRef, from: string): void {
        this.implementsApis.push(ref);
        // First contributor wins, matching dedupApiRefs' keep-the-first rule on the ref list.
        if (from !== this.node && !this.implementsVia.has(ref.api))
            this.implementsVia.set(ref.api, from);
    }

    addUses(ref: ApiRef): void {
        this.usesApis.push(ref);
    }
}
