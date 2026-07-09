/**
 * DI Design DOT Emitter
 *
 * Renders one DiDesign (a single controller/root's dependency tree) as a
 * Graphviz DOT digraph, mirroring the look of the architecture graph
 * (lib/graph-visualizer.ts): rankdir=TB with { rank=same } layers per level,
 * so the controller (level 0) sits at the top and injections fan downward.
 */

import { DiDesign, DiNode } from './model';

/**
 * Node fill colors by DI node kind.
 */
const KIND_COLORS: Record<string, string> = {
    controller: '#E3F2FD', // light blue — the root/entry class (server @DocumentDesign)
    apiImplementation: '#E0F2F1', // light teal — the root/entry class (designed-lib @DocumentDesign)
    component: '#E8F5E9', // light green — the root/entry Angular component
    class: '#F5F5F5', // neutral — plain injectable class
    constant: '#FFF3E0', // light orange — toConstantValue leaf
    dynamic: '#FFF3E0', // light orange — toDynamicValue leaf
    unresolved: '#FCE4EC', // light pink — token the analyzer could not resolve
    external: '#EDE7F6', // light violet — class from a published package; walk stops here
    api: '#E1F5FE', // light cyan — generated API-client proxy; service boundary, walk stops here
};

/** Escape a string for use inside a double-quoted DOT identifier/label. */
function dotEscape(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/**
 * A transient node is 1-to-many: EVERY arrow into it resolves its own instance, unlike a
 * singleton whose arrows all share one. `box3d` is Graphviz's stacked-slab glyph, so the raw
 * .dot (and any external DOT viewer) reads "many" too. design.html additionally paints a real
 * 3-box offset stack over it — see design-visualizer.ts.
 *
 * Leaves (constant/dynamic) and unresolved boxes are never instances, so they never stack.
 */
// webpieces-disable no-function-outside-class -- pure predicate over a DiNode, matching every sibling in this file
export function isStackedNode(node: DiNode): boolean {
    if (node.kind === 'constant' || node.kind === 'dynamic' || node.kind === 'unresolved') return false;
    return node.scope === 'transient';
}

function nodeStatement(node: DiNode): string {
    const color = KIND_COLORS[node.kind] ?? '#F5F5F5';
    // Injected as an API → show the contract on top, the impl class in parens beneath.
    const name = node.api
        ? `${dotEscape(node.api)}\\n(${dotEscape(node.className)})`
        : dotEscape(node.className);
    const label = `${name}\\n(L${node.level}, ${node.scope})`;
    const styles: string[] = ['filled'];
    if (node.kind === 'constant' || node.kind === 'dynamic') styles.push('rounded');
    if (node.kind === 'unresolved') styles.push('dashed');
    if (node.kind === 'api') styles.push('rounded');
    // External/api boundary: bold double border so it reads as "stops here, not
    // expanded" and is not mistaken for the pink dashed `unresolved` boxes.
    if (node.kind === 'external' || node.kind === 'api') styles.push('bold');
    const isRootKind =
        node.kind === 'controller' || node.kind === 'apiImplementation' || node.kind === 'component';
    const isBoundary = node.kind === 'external' || node.kind === 'api';
    const penwidth = isRootKind || isBoundary ? ', penwidth=2' : '';
    const peripheries = isBoundary ? ', peripheries=2' : '';
    // Transient => a fresh instance per injection. box3d reads as a stack of instances.
    const shape = isStackedNode(node) ? ', shape=box3d' : '';
    return `  "${dotEscape(node.id)}" [fillcolor="${color}", style="${styles.join(',')}", label="${label}"${penwidth}${peripheries}${shape}];\n`;
}

/**
 * Generate a Graphviz DOT digraph for one design (one controller/root tree).
 * Deterministic for a serializer-sorted design.
 */
export function generateDesignDot(design: DiDesign): string {
    let dot = `digraph "${dotEscape(design.root)}" {\n`;
    dot += '  rankdir=TB;\n';
    dot += '  node [shape=box, fontname="Arial"];\n';
    dot += '  edge [fontname="Arial", fontsize=11];\n\n';

    // Nodes, colored by kind, labeled with their level + scope
    for (const node of design.nodes) {
        dot += nodeStatement(node);
    }

    dot += '\n';

    // One { rank=same } layer per level so the root stays on top
    const levels = new Map<number, string[]>();
    for (const node of design.nodes) {
        const layer = levels.get(node.level) ?? [];
        layer.push(node.id);
        levels.set(node.level, layer);
    }
    const sortedLevels = Array.from(levels.keys()).sort((a: number, b: number) => a - b);
    for (const level of sortedLevels) {
        const ids = levels.get(level) ?? [];
        dot += `  { rank=same; ${ids.map((id: string) => `"${dotEscape(id)}"`).join('; ')}; }\n`;
    }

    dot += '\n';

    // Constructor-injection edges, unlabeled — the arrow alone shows the
    // dependency. The param/field name, token and tokenKey stay in design.json
    // for tooling that wants them.
    for (const edge of design.edges) {
        dot += `  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}";\n`;
    }

    dot += '\n  labelloc="t";\n';
    dot += `  label="${dotEscape(design.root)}\\n(${design.rootKind}, Level 0-${design.maxLevel})";\n`;
    dot += '  fontsize=16;\n';
    dot += '}\n';

    return dot;
}
