/**
 * Level bands for the architecture graph.
 *
 * Every row of architecture/dependencies.html is ONE dependency level: the highest level on top,
 * descending as you read down, L0 — the foundation everything is built on — always last.
 *
 * `{ rank=same; ... }` alone does not deliver that, and assuming it did was the bug. It ties a
 * level's boxes to one row but says nothing about where that row goes, so graphviz derived each
 * row's position from the edges. A level containing a box with no visible edges — a leaf sdk, an
 * api-lib whose only consumers are hidden — is unconstrained, so it was placed at the top rank and
 * dragged its ENTIRE level up with it (verified against graphviz: that is what put the L0 sdks in
 * the top row, and what parked an L0 lib in the same row as the L6 servers).
 *
 * So the ordering is STATED here rather than inferred: one invisible anchor per band, sitting in
 * that band's rank set, chained top-to-bottom with invisible edges. Ranks are then a function of
 * level and nothing else. The anchors — never the real boxes — carry the chain, so no fake
 * dependency is ever drawn between two projects.
 */

/**
 * A band bigger than this gets a blank spacer band inserted next to it, so the long edges leaving a
 * crowded row have vertical room to fan out instead of cutting straight through the row below.
 * Eleven-plus boxes in a row is where that became unreadable in practice.
 */
const SPACER_MIN_BAND_SIZE = 10;

/**
 * The class stamped on every node and edge that exists ONLY to pin the layout. Graphviz drops
 * `style=invis` elements from its SVG entirely, so nothing carrying this class reaches the page
 * today; the class is how the DOT tells the browser client which elements are scaffolding, and the
 * client skips them when indexing so an anchor can never be walked as a dependency.
 */
export const LAYOUT_CLASS = 'wp-layout';

/** Attributes shared by every invisible layout node (rank anchors and spacer bands). */
const LAYOUT_NODE_ATTRS =
    `[style=invis, shape=point, width=0.01, height=0.01, label="", class="${LAYOUT_CLASS}"]`;

/** Attributes for the invisible edges that force one band strictly above the next. */
const LAYOUT_EDGE_ATTRS = `[style=invis, class="${LAYOUT_CLASS}"]`;

/**
 * One horizontal band of the graph: every visible project sharing a dependency level, plus the
 * invisible anchor that pins the band's vertical position.
 */
export class LevelBand {
    level: number;
    /** Short names of the visible projects on this level, sorted for deterministic output. */
    nodeNames: string[];

    constructor(level: number, nodeNames: string[]) {
        this.level = level;
        this.nodeNames = nodeNames;
    }

    anchorName(): string {
        return `__wp_layout_L${this.level}`;
    }
}

/** Emits the DOT that pins each band to its own rank, in descending level order. */
export class LevelBandLayout {
    /**
     * @param bands the visible projects grouped by level, HIGHEST LEVEL FIRST. Levels need not be
     *        contiguous — only the levels actually present get a band, and the chain links
     *        whichever ones exist.
     */
    dot(bands: LevelBand[]): string {
        let dot = '';
        for (const band of bands) {
            dot += `  "${band.anchorName()}" ${LAYOUT_NODE_ATTRS};\n`;
            dot += `  { rank=same; "${band.anchorName()}"; `;
            for (const name of band.nodeNames) dot += `"${name}"; `;
            dot += '}\n';
        }
        for (let i = 0; i + 1 < bands.length; i++) {
            dot += this.bandGap(bands[i], bands[i + 1]);
        }
        return dot;
    }

    /**
     * The ordering chain between two adjacent bands. When either band is crowded
     * (> SPACER_MIN_BAND_SIZE boxes), an empty spacer band goes between them: the edges leaving a
     * wide row then have a whole rank of vertical room to fan out in, instead of being drawn
     * straight through the row below.
     */
    private bandGap(upper: LevelBand, lower: LevelBand): string {
        const crowded = upper.nodeNames.length > SPACER_MIN_BAND_SIZE
            || lower.nodeNames.length > SPACER_MIN_BAND_SIZE;
        if (!crowded) {
            return `  "${upper.anchorName()}" -> "${lower.anchorName()}" ${LAYOUT_EDGE_ATTRS};\n`;
        }
        const spacer = `__wp_layout_spacer_L${upper.level}_L${lower.level}`;
        return `  "${spacer}" ${LAYOUT_NODE_ATTRS};\n`
            + `  { rank=same; "${spacer}"; }\n`
            + `  "${upper.anchorName()}" -> "${spacer}" ${LAYOUT_EDGE_ATTRS};\n`
            + `  "${spacer}" -> "${lower.anchorName()}" ${LAYOUT_EDGE_ATTRS};\n`;
    }
}
