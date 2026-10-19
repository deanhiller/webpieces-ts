/**
 * The drift guard #1155 asked for: react-native shipped with a validator entry but no graph color and
 * no legend row, and the `app`/`bundle` borders were drawn but never explained. These assertions tie
 * the renderer's colors and legend to the SHARED vocabularies, so the next framework or role added to
 * them fails here instead of silently rendering grey.
 */

import { describe, it, expect } from 'vitest';
import { KNOWN_FRAMEWORKS } from '@webpieces/rules-sdk';
import {
    FRAMEWORK_STYLES,
    FrameworkStyle,
    LegendFacts,
    NodeFacts,
    NodeModeStyler,
    DARK_TEXT,
    LIGHT_TEXT,
    ROLE_STYLES,
    RoleStyle,
} from '../graph-color-modes';
import { GraphLegend } from '../graph-legend';
import { KNOWN_ROLES } from '../role-resolver';
import { htmlLabelText } from '../dot-syntax';
import { GraphPageStyles } from '../graph-page-styles';
import { LevelBand, LevelBandLayout } from '../graph-level-bands';
import {
    PRODUCT_OFF_FILL,
    PRODUCTS_ON_AT_LOAD,
    ProductBoundary,
    ProductColor,
    ProductPalette,
    ProductTemplateKind,
} from '../graph-products';
import { FilterFixture } from './graph-filter-fixture';
import { GraphVisualizer } from '../graph-visualizer';
import { RenderEdge } from '../graph-render-model';
import type { EnhancedGraph } from '../graph-sorter';
import { ProductDependencyEntry } from '../../configs/tag-truth-configs';

const styler = new NodeModeStyler();
const legend = new GraphLegend();
/** A workspace that declares no product. */
const NO_PRODUCTS = new ProductPalette([]);

/** Legend facts as if every framework and every role were drawn. */
const everything = (): LegendFacts => {
    const facts = new LegendFacts();
    for (const framework of KNOWN_FRAMEWORKS)
        styler.record(facts, new NodeFacts(framework, framework, 0, 'lib', [framework], []), NO_PRODUCTS);
    for (const role of KNOWN_ROLES) styler.record(facts, new NodeFacts(role, role, 0, role, [], []), NO_PRODUCTS);
    return facts;
};

describe('every known framework has a color and a legend row', () => {
    it.each([...KNOWN_FRAMEWORKS])('%s', (framework: string) => {
        const style = styler.styleOf(framework);
        expect(style).toBeDefined();
        expect(style!.color).toMatch(/^#[0-9a-f]{6}$/i);
        expect(legend.runtimeRows(everything())).toContain(`data-wp-legend="${framework}"`);
    });

    it('covers the six the framework-tag validator knows, react-native included', () => {
        expect([...KNOWN_FRAMEWORKS].sort()).toEqual(
            ['angular', 'browser', 'express', 'node', 'react', 'react-native'],
        );
        expect(Object.keys(FRAMEWORK_STYLES).sort()).toEqual([...KNOWN_FRAMEWORKS].sort());
    });

    it('gives every runtime a distinct color', () => {
        const colors = Object.values(FRAMEWORK_STYLES).map((style: FrameworkStyle): string => style.color);
        expect(new Set(colors).size).toBe(colors.length);
    });
});

describe('every role the renderer styles has a color and a legend row', () => {
    it('styles exactly the roles role-resolver knows', () => {
        expect([...styler.styledRoles()].sort()).toEqual([...KNOWN_ROLES].sort());
    });

    it.each(ROLE_STYLES.map((style: RoleStyle): string => style.role))('%s', (role: string) => {
        expect(legend.architectureRows(everything())).toContain(`data-wp-legend="${role}"`);
    });

    it('lists only the roles in use', () => {
        const facts = new LegendFacts();
        styler.record(facts, new NodeFacts('svc', 'svc', 1, 'server', ['node'], []), NO_PRODUCTS);
        const rows = legend.architectureRows(facts);
        expect(rows).toContain('data-wp-legend="server"');
        expect(rows).not.toContain('data-wp-legend="app"');
    });
});

describe('the brand palette (#1158)', () => {
    it('uses the LangLearn-matched runtime colors, with text colors that read on them', () => {
        const colors = Object.fromEntries(
            Object.values(FRAMEWORK_STYLES).map((style: FrameworkStyle): [string, string] => [
                style.framework,
                `${style.color}/${style.fontColor}`,
            ]),
        );
        expect(colors).toEqual({
            browser: '#7d8cf2/#1a1c22',
            node: '#6fcf8a/#1a1c22',
            'react-native': '#34b8a6/#1a1c22',
            angular: '#c8243f/#ffffff',
            react: '#7fd8ff/#1a1c22',
            express: '#2e7d4f/#ffffff',
        });
    });

    it('moves bundle to indigo, so no box color equals the violet accent', () => {
        const fills = ROLE_STYLES.map((style: RoleStyle): string => style.fill);
        expect(ROLE_STYLES.find((style: RoleStyle): boolean => style.role === 'bundle')!.fill).toBe('#4b44c8');
        for (const color of [...fills, ...Object.values(FRAMEWORK_STYLES).map((s: FrameworkStyle): string => s.color)])
            expect(['#8b3cf0', '#a46bf7']).not.toContain(color);
    });

    it('styles the drawer charcoal with the violet accent, and keeps the canvas light', () => {
        const css = new GraphPageStyles().css();
        for (const token of ['--wp-side-bg: #15161b', '--wp-side-control: #1e1f25', '--wp-side-line: #3a3c46',
            '--wp-accent: #8b3cf0', '--wp-accent-hover: #a46bf7', '--wp-canvas: #faf9f5'])
            expect(css).toContain(token);
    });
});

describe('Runtime boxes: solid, nested or striped — never bands or a plate', () => {
    it('stripes a universal library full height, equally, in the fixed order browser | node | react-native', () => {
        const dot = styler.dots(new NodeFacts('u', 'u', 0, 'lib', ['react-native', 'node', 'browser'], [])).runtime;
        expect(dot).toContain('style="striped", fillcolor="#7d8cf2;0.333:#6fcf8a;0.333:#34b8a6", class="wp-striped"');
        expect(dot).not.toContain('<TABLE');
        expect(dot).toContain('<BR/>browser · node · react-native>');
    });

    it('draws a react-native-only box teal, as a plain fill with the three lines', () => {
        const dot = styler.dots(new NodeFacts('rn', 'rn', 0, 'client', ['react-native'], [])).runtime;
        expect(dot).toBe(
            '  "rn" [style="filled", fillcolor="#34b8a6", fontcolor="#1a1c22", label=<<FONT COLOR="#1a1c2299">L0</FONT>' +
                '&#160;&#160;<B>rn</B><BR/>client<BR/>react-native>];\n',
        );
    });

    it('NESTS one runtime plus a specialization: base frame, rounded inner box, text color of the inner', () => {
        const dot = styler.dots(new NodeFacts('site', 'site', 3, 'client', ['browser', 'angular'], [])).runtime;
        expect(dot).toContain('fillcolor="#7d8cf2", fontcolor="#ffffff", margin=0');
        expect(dot).toContain(
            '<TD BGCOLOR="#7d8cf2" CELLPADDING="5"><TABLE BORDER="0" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" BGCOLOR="#c8243f" STYLE="rounded"><TR><TD><FONT COLOR="#ffffff99">L3</FONT>',
        );
        // react is light, so its text stays dark.
        const react = styler.dots(new NodeFacts('r', 'r', 1, 'lib', ['react'], [])).runtime;
        expect(react).toContain('fontcolor="#1a1c22", margin=0');
        expect(react).toContain('BGCOLOR="#7fd8ff" STYLE="rounded"');
    });

    it('shows a specialization on a multi-runtime box in line 3 only', () => {
        const dot = styler.dots(new NodeFacts('hooks', 'hooks', 4, 'lib', ['react', 'react-native'], [])).runtime;
        expect(dot).toContain('style="striped", fillcolor="#7d8cf2;0.500:#34b8a6"');
        expect(dot).not.toContain('#7fd8ff');
        expect(dot).toContain('<BR/>react-native · react>');
    });

    it('entity-escapes names inside HTML-like labels', () => {
        expect(htmlLabelText('a<b>&"c"')).toBe('a&lt;b&gt;&amp;&quot;c&quot;');
        const dot = styler.dots(new NodeFacts('x', 'a<b>', 0, 'lib', ['angular'], [])).runtime;
        expect(dot).toContain('<B>a&lt;b&gt;</B>');
        expect(dot).not.toContain('a<b>');
    });
});

describe('hover glow and lock outline stay on the OUTER box (#1158)', () => {
    const css = new GraphPageStyles().css();
    const later = ':is(polygon, ellipse, path) ~ :is(polygon, ellipse, path)';

    it('suppresses the glow on every shape after the first, whatever its element type', () => {
        // A nested box renders its inner STYLE="rounded" table as a <path>, after the node's polygon:
        // the old `polygon:not(:first-of-type)` rule missed it and the glow stroked the inner box.
        expect(css).toContain(`#graph g.wp-node-clickable:hover > ${later} { stroke: none; stroke-width: 0; filter: none; }`);
        expect(css).not.toContain('polygon:not(:first-of-type)');
    });

    it('locks the first shape only — and a striped box by its last, unfilled outline', () => {
        expect(css).toContain(`#graph g.node.wp-locked:not(.wp-striped) > :is(polygon, ellipse, path):not(${later}),`);
        expect(css).toContain('#graph g.node.wp-locked.wp-striped > polygon[fill="none"] { stroke: var(--wp-accent); stroke-width: 3; }');
        expect(css).not.toContain('g.node.wp-locked > path');
        expect(css).toContain('#graph g.wp-node-clickable.wp-striped:hover > polygon[fill="none"] { stroke: var(--wp-accent)');
    });
});

describe('an emptied level is a thin labeled band, never dropped', () => {
    it('keeps the empty band in the rank chain with a visible label', () => {
        const dot = new LevelBandLayout().dot([new LevelBand(2, ['a']), new LevelBand(1, []), new LevelBand(0, ['b'])]);
        expect(dot).toContain('"__wp_layout_L1" [shape=plaintext');
        expect(dot).toContain('label="L1 · no matching projects", class="wp-layout wp-empty-level"]');
        expect(dot).toContain('"__wp_layout_L2" -> "__wp_layout_L1"');
        expect(dot).toContain('"__wp_layout_L1" -> "__wp_layout_L0"');
    });
});


describe('Product mode (#1179): the legend counts, and the template the page paints from (#1319)', () => {
    const palette = new ProductPalette(['lang', 'helper', 'bugfixer']);
    const paint = FilterFixture.productPaint();

    it('assigns the palette in sorted product-name order', () => {
        expect(palette.names()).toEqual(['bugfixer', 'helper', 'lang']);
        expect(new Set(palette.colors.map((color: ProductColor): string => color.color)).size).toBe(3);
    });

    it('hands the page a BOX template: the statement head and the label in both text colors', () => {
        const facts = new NodeFacts('p', 'p', 2, 'lib', ['node'], ['lang']);
        const template = styler.dots(facts).product;
        expect(template.kind).toBe(ProductTemplateKind.BOX);
        expect(template.head).toBe('  "p" [');
        expect(template.darkLabel).toBe(styler.labelText(facts, DARK_TEXT));
        expect(template.lightLabel).toBe(styler.labelText(facts, LIGHT_TEXT));
        const dot = paint.painter(palette.colors, ['lang']).nodeDot(template, facts.products);
        const lang = palette.colorOf('lang');
        expect(dot).toBe(
            `  "p" [style="filled", fillcolor="${lang.color}", fontcolor="${lang.fontColor}", label=<${styler.labelText(facts, lang.fontColor)}>];\n`,
        );
    });

    it('uses the same product fill in nodes and legend even beyond eight products', () => {
        const names = Array.from({ length: 12 }, (_: unknown, i: number): string => `product-${i}`);
        const big = new ProductPalette(names);
        const last = big.colorOf(names[names.length - 1]);
        const facts = new LegendFacts();
        const node = new NodeFacts('x', 'x', 0, 'lib', [], [last.product]);
        styler.record(facts, node, big);
        expect(paint.painter(big.colors, [last.product]).nodeDot(styler.dots(node).product, node.products)).toContain(
            `fillcolor="${last.color}"`,
        );
        expect(legend.productRows(facts)).toContain(last.color);
        expect(legend.productRows(facts)).not.toContain('past the palette');
    });

    it('the legend counts each product (total and only-this-product), shared, several, off and none', () => {
        const facts = new LegendFacts();
        styler.record(facts, new NodeFacts('a', 'a', 0, 'server', [], ['lang']), palette);
        styler.record(facts, new NodeFacts('b', 'b', 0, 'lib', [], ['helper', 'lang']), palette);
        styler.record(facts, new NodeFacts('c', 'c', 0, 'lib', [], ['bugfixer', 'helper', 'lang']), palette);
        styler.record(facts, new NodeFacts('d', 'd', 0, 'lib', [], []), palette);
        const rows = legend.productRows(facts);
        expect(rows).toContain('lang · 3<small>1 only lang</small>');
        expect(rows).toContain('helper · 2<small>0 only helper</small>');
        expect(rows).toContain('shared by every product · 1');
        expect(rows).toContain('neutral only while every product is ON');
        expect(rows).toContain('data-wp-legend="several"');
        expect(rows).toContain('one stripe per ON product');
        expect(rows).toContain('data-wp-legend="off"');
        expect(rows).toContain(PRODUCT_OFF_FILL);
        expect(rows).toContain('no product · 1');
    });

    it('makes every product row a toggle, unchecked in the markup (the page checks the first two), with the note', () => {
        const facts = new LegendFacts();
        styler.record(facts, new NodeFacts('a', 'a', 0, 'server', [], ['lang']), palette);
        const rows = legend.productRows(facts);
        for (const product of palette.names())
            expect(rows).toContain(
                `<label class="wp-legend-row wp-product-toggle" data-wp-legend="product:${product}"><input type="checkbox" data-wp-product-toggle="${product}">`,
            );
        expect(rows).not.toContain('checked');
        expect(rows).toContain(`the first ${PRODUCTS_ON_AT_LOAD} are ON on every load`);
        expect(rows).toContain('A color always means the same product.');
    });

    it('says how to declare a product when the workspace declares none', () => {
        expect(legend.productRows(new LegendFacts())).toContain('no products declared');
        expect(legend.productRows(new LegendFacts())).not.toContain('data-wp-product-toggle');
    });
});

describe('Product mode (#1204): product boundaries — dashed cross-product edges and the allowed matrix', () => {
    const boundary = new ProductBoundary();
    const entry = (name: string, allowed: string[]): ProductDependencyEntry =>
        Object.assign(new ProductDependencyEntry(), { name, allowedToDependOn: allowed });

    it('an edge crosses when its target misses some product of its source, into the products it adds', () => {
        expect(boundary.crossedInto(['example'], ['platform'])).toEqual(['platform']);
        expect(boundary.crossedInto(['openapi'], ['platform', 'rules'])).toEqual(['platform', 'rules']);
        expect(boundary.crossedInto(['example', 'platform'], ['platform'])).toEqual(['platform']);
        expect(boundary.crossedInto(['lang'], ['lang'])).toEqual([]);
        expect(boundary.crossedInto(['lang'], ['helper', 'lang'])).toEqual([]);
        expect(boundary.crossedInto([], ['lang'])).toEqual([]);
        expect(boundary.crossedInto(['lang'], [])).toEqual([]);
    });

    it('draws a cross-product edge dashed in the TARGET product color in Product mode only; same-product edges stay plain', () => {
        const graph: EnhancedGraph = {
            app: { level: 1, dependsOn: ['lib', 'plat'], role: 'server', framework: ['node'], products: ['example'] },
            lib: { level: 0, dependsOn: [], role: 'lib', framework: ['node'], products: ['example'] },
            plat: { level: 0, dependsOn: [], role: 'lib', framework: ['node'], products: ['platform'] },
        };
        const model = new GraphVisualizer(() => '', () => '').generateRenderModel(graph);
        const palette = new ProductPalette(['example', 'platform']);
        const toPlat = model.edges.find((edge: RenderEdge): boolean => edge.to === 'plat')!;
        const toLib = model.edges.find((edge: RenderEdge): boolean => edge.to === 'lib')!;
        expect(toLib.crossesInto).toEqual([]);
        expect(toPlat.dot).not.toContain('dashed');
        expect(toPlat.crossesInto).toEqual(['platform']);
        const painter = FilterFixture.productPaint().painter(palette.colors, ['example', 'platform']);
        expect(painter.edgeDot(toLib)).toBe(toLib.dot);
        expect(painter.edgeDot(toPlat)).toContain(
            `[id="${toPlat.id}"] [style=dashed, color="${palette.colorOf('platform').color}", penwidth=2];`,
        );
        expect(FilterFixture.productPaint().painter(palette.colors, ['example']).edgeDot(toPlat)).toBe(toPlat.dot);
        expect(model.fullDot).not.toContain('penwidth=2');
        expect(model.legend.crossProductEdges).toBe(1);
        expect(legend.productRows(model.legend)).toContain('crosses into another product · 1');
    });

    it('the legend lists the allowed matrix, sorted, when the rule supplies one', () => {
        const palette = new ProductPalette(['example', 'openapi', 'platform']);
        const facts = new LegendFacts();
        styler.record(facts, new NodeFacts('a', 'a', 0, 'server', [], ['example']), palette);
        facts.productDependencies = [entry('openapi', ['platform']), entry('example', ['platform', 'openapi'])];
        const rows = legend.productRows(facts);
        expect(rows).toContain('example → openapi, platform');
        expect(rows.indexOf('example →')).toBeLessThan(rows.indexOf('openapi →'));
        expect(rows).toContain('allowed by product-tags.productDependencies');
    });

    it('says no product may depend on another for an empty matrix, and lists nothing when the rule is OFF', () => {
        const palette = new ProductPalette(['example']);
        const facts = new LegendFacts();
        styler.record(facts, new NodeFacts('a', 'a', 0, 'server', [], ['example']), palette);
        expect(legend.productRows(facts)).not.toContain('productDependencies');
        facts.productDependencies = [];
        expect(legend.productRows(facts)).toContain('no product may depend on another');
    });
});
