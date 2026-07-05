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
    controller: '#E3F2FD', // light blue — the root/entry class
    class: '#F5F5F5', // neutral — plain injectable class
    constant: '#FFF3E0', // light orange — toConstantValue leaf
    dynamic: '#FFF3E0', // light orange — toDynamicValue leaf
    unresolved: '#FCE4EC', // light pink — token the analyzer could not resolve
};

/** Escape a string for use inside a double-quoted DOT identifier/label. */
function dotEscape(text: string): string {
    return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function nodeStatement(node: DiNode): string {
    const color = KIND_COLORS[node.kind] ?? '#F5F5F5';
    const label = `${dotEscape(node.className)}\\n(L${node.level}, ${node.scope})`;
    const styles: string[] = ['filled'];
    if (node.kind === 'constant' || node.kind === 'dynamic') styles.push('rounded');
    if (node.kind === 'unresolved') styles.push('dashed');
    const penwidth = node.kind === 'controller' ? ', penwidth=2' : '';
    return `  "${dotEscape(node.id)}" [fillcolor="${color}", style="${styles.join(',')}", label="${label}"${penwidth}];\n`;
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

    // Constructor-injection edges; labels mirror design.md (mermaid.ts)
    for (const edge of design.edges) {
        const token = edge.injection === 'multiInject' ? `multiInject ${edge.token}` : edge.token;
        const label = token !== '' ? ` [label="${dotEscape(token)}"]` : '';
        dot += `  "${dotEscape(edge.from)}" -> "${dotEscape(edge.to)}"${label};\n`;
    }

    dot += '\n  labelloc="t";\n';
    dot += `  label="${dotEscape(design.root)}\\n(${design.rootKind}, Level 0-${design.maxLevel})";\n`;
    dot += '  fontsize=16;\n';
    dot += '}\n';

    return dot;
}
