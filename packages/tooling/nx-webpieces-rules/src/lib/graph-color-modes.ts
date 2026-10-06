/**
 * Graph color modes (#1155, restyled by #1158)
 *
 * The architecture graph answers ONE question at a time instead of asking every box to encode two
 * (fill = framework AND border = role). Each box is emitted once per mode, so the page can switch
 * modes and re-render without regenerating anything. Every mode writes the SAME three lines on a box
 * (level + name, role, every framework tag); only the color changes:
 *
 *  - RUNTIME      "where the code can run". One runtime is a solid fill. One runtime plus a
 *                 specialization (angular/react inside browser, express inside node) is NESTED: an
 *                 outer frame in the base color around an inner rounded box in the specialization's
 *                 color, carrying the text. Several runtimes are full-height vertical stripes in the
 *                 fixed order browser | node | react-native, with the text written across them. The
 *                 dependency rule becomes visual: a box may depend on a box carrying every color it has.
 *  - ARCHITECTURE "servers · clients · APIs". A solid fill by ROLE; framework color is not shown.
 *  - IMPACT       "what this branch touches". Projects owning a changed file are solid amber
 *                 ("touched"); the rest of nx's affected set is light amber ("affected": their ci
 *                 re-runs); every transitive dependency of the affected set that is not itself
 *                 affected is light slate with a dashed border ("build input": compiled or restored
 *                 from cache, unchanged); everything else is grey. Which box is which is only known
 *                 per branch, so every box carries all four variants and the page picks one from the
 *                 sidecar (graph-impact.ts). The state is never written on the box: color + legend.
 */

import { KNOWN_FRAMEWORKS, KnownFramework } from '@webpieces/rules-sdk';
import { dotValue, htmlLabelText } from './dot-syntax';

export enum GraphMode {
    RUNTIME = 'runtime',
    ARCHITECTURE = 'architecture',
    IMPACT = 'impact',
}

/** One selectable mode as the drawer's Color-by pulldown shows it. */
export class ModeInfo {
    constructor(
        public readonly mode: GraphMode,
        public readonly name: string,
        public readonly subtitle: string,
    ) {}
}

/** In key order: `1` selects the first, `2` the second, `3` the third. */
export const GRAPH_MODES: readonly ModeInfo[] = [
    new ModeInfo(GraphMode.RUNTIME, 'Runtime', 'where the code can run'),
    new ModeInfo(GraphMode.ARCHITECTURE, 'Architecture', 'servers · clients · APIs'),
    new ModeInfo(GraphMode.IMPACT, 'Impact', 'what this branch touches'),
];

/** Text on a light fill. */
export const DARK_TEXT = '#1a1c22';
/** Text on a dark fill. */
export const LIGHT_TEXT = '#ffffff';

/**
 * A framework value's color, the text color that reads on it, and the BASE runtime it is drawn
 * inside (itself, for a base).
 */
export class FrameworkStyle {
    constructor(
        public readonly framework: KnownFramework,
        public readonly base: KnownFramework,
        public readonly color: string,
        public readonly fontColor: string,
        public readonly description: string,
    ) {}

    isBase(): boolean {
        return this.framework === this.base;
    }
}

/**
 * Keyed by the shared vocabulary, so a framework added to KNOWN_FRAMEWORKS without a color here is a
 * COMPILE error — not a box silently painted grey and missing from the legend, which is exactly how
 * react-native shipped (#1155). Every base is mid-light, so dark text reads on every stripe.
 */
export const FRAMEWORK_STYLES: Record<KnownFramework, FrameworkStyle> = {
    browser: new FrameworkStyle('browser', 'browser', '#7d8cf2', DARK_TEXT, 'browser base runtime'),
    node: new FrameworkStyle('node', 'node', '#6fcf8a', DARK_TEXT, 'node base runtime'),
    'react-native': new FrameworkStyle(
        'react-native',
        'react-native',
        '#34b8a6',
        DARK_TEXT,
        'its own runtime, not a browser',
    ),
    angular: new FrameworkStyle('angular', 'browser', '#c8243f', LIGHT_TEXT, 'inside browser'),
    react: new FrameworkStyle('react', 'browser', '#7fd8ff', DARK_TEXT, 'inside browser'),
    express: new FrameworkStyle('express', 'node', '#2e7d4f', LIGHT_TEXT, 'inside node'),
};

/** Stripe order, left to right. Fixed, so the same set always reads the same way. */
export const BASE_ORDER: readonly KnownFramework[] = ['browser', 'node', 'react-native'];

/**
 * The Filter popover's Runtime chips, and the order line 3 of a box lists framework tags in: the
 * bases first, then the specializations.
 */
export const FRAMEWORK_ORDER: readonly KnownFramework[] = [
    'browser',
    'node',
    'react-native',
    'angular',
    'react',
    'express',
];

/** A box with no known framework tag. */
export const NO_RUNTIME_COLOR = '#e4e6ec';

/** The class Graphviz stamps on a multi-runtime box's `<g>`: its outline is its LAST shape. */
export const STRIPED_CLASS = 'wp-striped';

/** Margin of base color around a specialization's inner box. */
const NEST_PAD = 5;
/** Padding between the inner box's edge and its text. */
const INNER_PAD = 6;

/** A role's solid fill and the text color that stays readable on it. */
export class RoleStyle {
    constructor(
        public readonly role: string,
        public readonly fill: string,
        public readonly fontColor: string,
        public readonly description: string,
    ) {}
}

/**
 * Every role role-resolver knows, in legend order (runnable things first) — also the Filter popover's
 * Role chips. `bundle` is indigo so no box color equals the page's violet accent.
 */
export const ROLE_STYLES: readonly RoleStyle[] = [
    new RoleStyle('server', '#4caf50', LIGHT_TEXT, 'runnable server'),
    new RoleStyle('client', '#e5533d', LIGHT_TEXT, 'browser or mobile client app'),
    new RoleStyle('app', '#1e88e5', LIGHT_TEXT, 'runnable non-HTTP app'),
    new RoleStyle('bundle', '#4b44c8', LIGHT_TEXT, 'bundles several apps'),
    new RoleStyle('api-lib', '#f08a24', DARK_TEXT, 'contract + DTOs'),
    new RoleStyle('api-client', '#1a9aa6', LIGHT_TEXT, 'contract + SDK implementation'),
    new RoleStyle('designed-lib', '#7d8597', LIGHT_TEXT, 'library with a generated design'),
    new RoleStyle('lib', '#d7dae2', DARK_TEXT, 'plain library'),
];

/** The four impact shades (graph-impact.ts decides which box gets which). */
export const IMPACT_TOUCHED = '#f5a524';
export const IMPACT_AFFECTED = '#fde3b0';
export const IMPACT_BUILD_INPUT = '#e3e9f2';
export const IMPACT_BUILD_INPUT_BORDER = '#7c8aa3';
export const IMPACT_UNTOUCHED = '#eef0f4';
const IMPACT_UNTOUCHED_TEXT = '#6b7180';

/** What a box's per-mode rendering — and the page's Filter — is computed from. */
export class NodeFacts {
    constructor(
        public readonly nodeId: string,
        public readonly shortName: string,
        public readonly level: number,
        public readonly role: string,
        public readonly frameworks: string[],
    ) {}
}

/** One box's DOT statement for every mode (and for each impact state). */
export class NodeModeDots {
    constructor(
        public readonly runtime: string,
        public readonly architecture: string,
        public readonly touched: string,
        public readonly affected: string,
        public readonly buildInput: string,
        public readonly untouched: string,
    ) {}
}

/** Which colors and roles the drawn projects actually use, so the legend lists exactly those. */
export class LegendFacts {
    frameworks: string[] = [];
    roles: string[] = [];
    multiRuntime = false;
    noRuntime = false;
}

export class NodeModeStyler {
    styleOf(framework: string): FrameworkStyle | undefined {
        if (!(KNOWN_FRAMEWORKS as readonly string[]).includes(framework)) return undefined;
        return FRAMEWORK_STYLES[framework as KnownFramework];
    }

    roleStyle(role: string): RoleStyle {
        const style = ROLE_STYLES.find((candidate: RoleStyle): boolean => candidate.role === role);
        return style ?? (ROLE_STYLES.find((s: RoleStyle): boolean => s.role === 'lib') as RoleStyle);
    }

    /** Every role the renderer styles; a spec asserts this covers role-resolver's KNOWN_ROLES. */
    styledRoles(): string[] {
        return ROLE_STYLES.map((style: RoleStyle): string => style.role);
    }

    /** The base runtimes of a framework set, in stripe order (a specialization implies its base). */
    bases(frameworks: string[]): KnownFramework[] {
        const present = new Set<KnownFramework>();
        for (const framework of frameworks) {
            const style = this.styleOf(framework);
            if (style !== undefined) present.add(style.base);
        }
        return BASE_ORDER.filter((base: KnownFramework): boolean => present.has(base));
    }

    /** The specialization drawn inside `base`, if the set carries one. */
    specialization(base: KnownFramework, frameworks: string[]): FrameworkStyle | undefined {
        for (const framework of KNOWN_FRAMEWORKS) {
            const style = FRAMEWORK_STYLES[framework];
            if (style.isBase() || style.base !== base) continue;
            if (frameworks.includes(framework)) return style;
        }
        return undefined;
    }

    dots(facts: NodeFacts): NodeModeDots {
        return new NodeModeDots(
            this.runtime(facts),
            this.plain(facts, this.roleStyle(facts.role).fill, this.roleStyle(facts.role).fontColor, ''),
            this.plain(facts, IMPACT_TOUCHED, DARK_TEXT, ''),
            this.plain(facts, IMPACT_AFFECTED, DARK_TEXT, `, color="${IMPACT_TOUCHED}", penwidth=2`),
            this.plain(
                facts,
                IMPACT_BUILD_INPUT,
                DARK_TEXT,
                `, color="${IMPACT_BUILD_INPUT_BORDER}", penwidth=1.5`,
                'filled,dashed',
            ),
            this.plain(facts, IMPACT_UNTOUCHED, IMPACT_UNTOUCHED_TEXT, ', color="#b4b9c4"'),
        );
    }

    /** Fold one drawn box into the legend facts. */
    record(legend: LegendFacts, facts: NodeFacts): void {
        for (const framework of facts.frameworks) {
            if (this.styleOf(framework) !== undefined && !legend.frameworks.includes(framework))
                legend.frameworks.push(framework);
        }
        const role = this.roleStyle(facts.role).role;
        if (!legend.roles.includes(role)) legend.roles.push(role);
        const bases = this.bases(facts.frameworks);
        if (bases.length > 1) legend.multiRuntime = true;
        if (bases.length === 0) legend.noRuntime = true;
    }

    /**
     * Line 3 of every box: every framework tag, bases before specializations, any tag outside the
     * shared vocabulary last (it still runs somewhere somebody declared).
     */
    frameworkLine(frameworks: string[]): string {
        if (frameworks.length === 0) return 'no framework tag';
        const known = FRAMEWORK_ORDER.filter((framework: KnownFramework): boolean =>
            frameworks.includes(framework),
        );
        const unknown = frameworks.filter((framework: string): boolean => this.styleOf(framework) === undefined);
        return [...known, ...unknown].join(' · ');
    }

    /**
     * The three lines, identical in every mode: `L3  name` (level dimmed, name bold), the role, and
     * the framework tags. The level is dimmed by giving its text color an alpha channel, which
     * Graphviz writes as `fill-opacity`, so it dims on any fill.
     */
    labelText(facts: NodeFacts, fontColor: string): string {
        return (
            `<FONT COLOR="${fontColor}99">L${facts.level}</FONT>&#160;&#160;<B>${htmlLabelText(facts.shortName)}</B>` +
            `<BR/>${htmlLabelText(facts.role)}<BR/>${htmlLabelText(this.frameworkLine(facts.frameworks))}`
        );
    }

    /** `filled` for one runtime; equal `striped` weights for several (the last takes the remainder). */
    stripeAttrs(bases: KnownFramework[]): string {
        const colors = bases.map((base: KnownFramework): string => FRAMEWORK_STYLES[base].color);
        if (colors.length === 1) return `style="filled", fillcolor="${colors[0]}"`;
        const share = (1 / colors.length).toFixed(3);
        const weighted = colors.map((color: string, index: number): string =>
            index === colors.length - 1 ? color : `${color};${share}`,
        );
        return `style="striped", fillcolor="${weighted.join(':')}", class="${STRIPED_CLASS}"`;
    }

    private statement(facts: NodeFacts, attrs: string, label: string): string {
        return `  "${dotValue(facts.nodeId)}" [${attrs}, label=<${label}>];\n`;
    }

    /** A solid fill, the three lines on it. `extra` carries border attributes. */
    private plain(facts: NodeFacts, fill: string, fontColor: string, extra: string, style = 'filled'): string {
        return this.statement(
            facts,
            `style="${style}", fillcolor="${fill}", fontcolor="${fontColor}"${extra}`,
            this.labelText(facts, fontColor),
        );
    }

    /**
     * Runtime mode. No runtime, or one runtime with no specialization: a solid fill. One runtime with a
     * specialization: NESTED. Several runtimes: full-height stripes with the text across them (a
     * specialization on such a box shows in line 3 only).
     */
    private runtime(facts: NodeFacts): string {
        const bases = this.bases(facts.frameworks);
        if (bases.length === 0) return this.plain(facts, NO_RUNTIME_COLOR, DARK_TEXT, '');
        if (bases.length > 1)
            return this.statement(
                facts,
                `${this.stripeAttrs(bases)}, fontcolor="${DARK_TEXT}"`,
                this.labelText(facts, DARK_TEXT),
            );
        const base = FRAMEWORK_STYLES[bases[0]];
        const inner = this.specialization(bases[0], facts.frameworks);
        if (inner === undefined) return this.plain(facts, base.color, base.fontColor, '');
        return this.statement(
            facts,
            `style="filled", fillcolor="${base.color}", fontcolor="${inner.fontColor}", margin=0`,
            this.nestedTable(base.color, inner, this.labelText(facts, inner.fontColor)),
        );
    }

    /**
     * An outer cell in the base color whose padding is the visible frame, holding an inner ROUNDED
     * table in the specialization's color that carries the text. The node's own polygon stays its
     * FIRST shape, so the hover glow and the lock outline land on the outer box only.
     */
    private nestedTable(base: string, inner: FrameworkStyle, text: string): string {
        return (
            '<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="0">' +
            `<TR><TD BGCOLOR="${base}" CELLPADDING="${NEST_PAD}">` +
            `<TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="${INNER_PAD}" BGCOLOR="${inner.color}" STYLE="rounded">` +
            `<TR><TD>${text}</TD></TR></TABLE></TD></TR></TABLE>`
        );
    }
}
