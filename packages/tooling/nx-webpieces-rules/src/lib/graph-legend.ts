/**
 * The architecture graph's legend, generated per color mode FROM THE PROJECTS ACTUALLY DRAWN.
 *
 * The hand-written legend this replaces listed five frameworks when six existed and never mentioned
 * the `app` and `bundle` borders the renderer drew (#1155). Generating the rows from the same tables
 * the renderer colors with (graph-color-modes.ts) means a color in use always has a row, and a color
 * nothing uses never does.
 *
 * Swatches are inline SVG drawn with presentation attributes, never `style=`, so the page carries
 * no inline CSS.
 */

import { KNOWN_FRAMEWORKS, KnownFramework } from '@webpieces/rules-sdk';
import {
    BASE_ORDER,
    FRAMEWORK_STYLES,
    FrameworkStyle,
    GraphMode,
    IMPACT_AFFECTED,
    IMPACT_BUILD_INPUT,
    IMPACT_BUILD_INPUT_BORDER,
    IMPACT_TOUCHED,
    IMPACT_UNTOUCHED,
    LegendFacts,
    NO_RUNTIME_COLOR,
    ROLE_STYLES,
    RoleStyle,
} from './graph-color-modes';

const SWATCH_W = 26;
const SWATCH_H = 16;
const FRAME = '#2b2f3a';

export class GraphLegend {
    /** One section per mode; the page shows the section of the current mode and hides the rest. */
    sections(facts: LegendFacts): string {
        return (
            this.section(GraphMode.RUNTIME, this.runtimeRows(facts), false) +
            this.section(GraphMode.ARCHITECTURE, this.architectureRows(facts), true) +
            this.section(GraphMode.IMPACT, this.impactRows(), true)
        );
    }

    /** The edge key: why a line exists. Static — every graph can carry every edge kind. */
    edgeKey(): string {
        return (
            '<div class="wp-legend-list">' +
            this.edgeRow('#e9eaf0', '', 'uses', 'calls the API, or a plain library import') +
            this.edgeRow('#e9eaf0', '4 3', 'implements', 'serves the API (labeled with its contracts)') +
            this.edgeRow('#7aa2ff', '4 3', 'uses + implements', 'implements some contracts, uses others') +
            '</div>'
        );
    }

    private section(mode: GraphMode, rows: string, hidden: boolean): string {
        const hide = hidden ? ' hidden' : '';
        return `<div class="wp-legend-list" data-wp-legend-mode="${mode}"${hide}>${rows}</div>`;
    }

    /** Base runtimes first (stripe order), then specializations, in the shared vocabulary's order. */
    runtimeRows(facts: LegendFacts): string {
        const present = (framework: KnownFramework): boolean => facts.frameworks.includes(framework);
        const ordered: FrameworkStyle[] = [
            ...BASE_ORDER.map((base: KnownFramework): FrameworkStyle => FRAMEWORK_STYLES[base]),
            ...KNOWN_FRAMEWORKS.map((f: KnownFramework): FrameworkStyle => FRAMEWORK_STYLES[f]).filter(
                (style: FrameworkStyle): boolean => !style.isBase(),
            ),
        ];
        let rows = '';
        for (const style of ordered) {
            if (!present(style.framework)) continue;
            rows += this.row(style.framework, this.envSwatch(style), style.framework, style.description);
        }
        if (facts.multiRuntime)
            rows += this.row('multi', this.stripesSwatch(), 'several runtimes', 'one equal stripe per runtime');
        if (facts.noRuntime)
            rows += this.row('none', this.solid(NO_RUNTIME_COLOR, '', ''), 'no framework tag', 'runs nowhere declared');
        return rows;
    }

    architectureRows(facts: LegendFacts): string {
        let rows = '';
        for (const style of ROLE_STYLES) {
            if (!facts.roles.includes(style.role)) continue;
            rows += this.row(style.role, this.roleSwatch(style), style.role, style.description);
        }
        return rows;
    }

    /** Which box is which is only known from the branch's sidecar, so all four rows always show. */
    private impactRows(): string {
        return (
            this.row('touched', this.solid(IMPACT_TOUCHED, '', ''), 'touched', 'files changed on this branch') +
            this.row('affected', this.solid(IMPACT_AFFECTED, IMPACT_TOUCHED, ''), 'affected', 'tests and build re-run') +
            this.row(
                'build-input',
                this.solid(IMPACT_BUILD_INPUT, IMPACT_BUILD_INPUT_BORDER, '3 2'),
                'build input',
                'compiled or restored from cache, unchanged',
            ) +
            this.row('untouched', this.solid(IMPACT_UNTOUCHED, '', ''), 'untouched', 'not part of this build') +
            '<p class="wp-impact-note" data-wp-impact-note></p>'
        );
    }

    private row(key: string, swatch: string, title: string, detail: string): string {
        return (
            `<div class="wp-legend-row" data-wp-legend="${key}">${swatch}` +
            `<span>${title}<small>${detail}</small></span></div>`
        );
    }

    private open(): string {
        return `<svg width="${SWATCH_W}" height="${SWATCH_H}" viewBox="0 0 ${SWATCH_W} ${SWATCH_H}" aria-hidden="true">`;
    }

    private frame(): string {
        return `<rect x="0.5" y="0.5" width="${SWATCH_W - 1}" height="${SWATCH_H - 1}" fill="none" stroke="${FRAME}"/></svg>`;
    }

    /** A base runtime is solid; a specialization is its inset on the base color. */
    private envSwatch(style: FrameworkStyle): string {
        const base = `<rect width="${SWATCH_W}" height="${SWATCH_H}" fill="${FRAMEWORK_STYLES[style.base].color}"/>`;
        if (style.isBase()) return this.open() + base + this.frame();
        const inset = `<rect x="4" y="4" width="${SWATCH_W - 8}" height="${SWATCH_H - 8}" rx="2" fill="${style.color}"/>`;
        return this.open() + base + inset + this.frame();
    }

    private stripesSwatch(): string {
        const width = SWATCH_W / BASE_ORDER.length;
        const stripes = BASE_ORDER.map(
            (base: KnownFramework, index: number): string =>
                `<rect x="${(index * width).toFixed(2)}" width="${width.toFixed(2)}" height="${SWATCH_H}" fill="${FRAMEWORK_STYLES[base].color}"/>`,
        ).join('');
        return this.open() + stripes + this.frame();
    }

    private roleSwatch(style: RoleStyle): string {
        return this.solid(style.fill, '', '');
    }

    /** A filled swatch, optionally with an inner ring (dashed when `dash` is set). */
    private solid(fill: string, outline: string, dash: string): string {
        const dashed = dash === '' ? '' : ` stroke-dasharray="${dash}"`;
        const ring =
            outline === ''
                ? ''
                : `<rect x="2" y="2" width="${SWATCH_W - 4}" height="${SWATCH_H - 4}" fill="none" stroke="${outline}" stroke-width="2"${dashed}/>`;
        return this.open() + `<rect width="${SWATCH_W}" height="${SWATCH_H}" fill="${fill}"/>` + ring + this.frame();
    }

    private edgeRow(color: string, dash: string, title: string, detail: string): string {
        const dashed = dash === '' ? '' : ` stroke-dasharray="${dash}"`;
        const line = `<svg width="28" height="10" aria-hidden="true"><line x1="0" y1="5" x2="28" y2="5" stroke="${color}" stroke-width="1.6"${dashed}/></svg>`;
        return this.row(title, line, title, detail);
    }
}
