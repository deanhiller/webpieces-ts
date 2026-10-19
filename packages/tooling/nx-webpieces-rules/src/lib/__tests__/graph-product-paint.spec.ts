/**
 * The Product color mode's paint decision (#1319), run from the SHIPPED client source in a bare VM:
 * which look a box gets for the products switched ON in the legend, and when a cross-product edge is
 * dashed. Colors are the fixed palette's (#1244), never reassigned to the ON set.
 */
import { describe, expect, it } from 'vitest';
import {
    PRODUCT_NONE_BORDER,
    PRODUCT_NONE_FILL,
    PRODUCT_OFF_BORDER,
    PRODUCT_OFF_FILL,
    PRODUCT_SHARED_FILL,
    PRODUCTS_ON_AT_LOAD,
    ProductPalette,
    ProductTemplate,
    ProductTemplateKind,
} from '../graph-products';
import { DARK_TEXT, LIGHT_TEXT, STRIPED_CLASS } from '../graph-color-modes';
import { RenderEdge } from '../graph-render-model';
import { FilterFixture } from './graph-filter-fixture';

const api = FilterFixture.productPaint();
const palette = new ProductPalette(['bugfixer', 'helper', 'lang']);
const color = (product: string): string => palette.colorOf(product).color;
const BOX = new ProductTemplate(ProductTemplateKind.BOX, '  "p" [', 'DARK', 'LIGHT');

describe('WpProductPainter (#1319): paint from the ON set', () => {
    it('starts every load with the first two products in legend order ON', () => {
        expect(api.initialOn(['bugfixer', 'helper', 'lang'])).toEqual(['bugfixer', 'helper']);
        expect(api.initialOn(['solo'])).toEqual(['solo']);
        expect(api.initialOn([])).toEqual([]);
    });

    it('carries exactly one ON product: solid in its fixed palette color', () => {
        const painter = api.painter(palette.colors, ['lang', 'helper']);
        const paint = painter.paint(['bugfixer', 'lang']);
        expect(paint.kind).toBe('solid');
        expect(paint.colors).toEqual([color('lang')]);
        expect(paint.fontColor).toBe(palette.colorOf('lang').fontColor);
        expect(painter.nodeDot(BOX, ['lang'])).toBe(
            `  "p" [style="filled", fillcolor="${color('lang')}", fontcolor="${palette.colorOf('lang').fontColor}", label=<${palette.colorOf('lang').fontColor === LIGHT_TEXT ? 'LIGHT' : 'DARK'}>];\n`,
        );
    });

    it('carries two or more ON products: one stripe per ON product, OFF ones left out', () => {
        const painter = api.painter(palette.colors, ['helper', 'lang']);
        const paint = painter.paint(['bugfixer', 'helper', 'lang']);
        expect(paint.kind).toBe('stripes');
        expect(paint.colors).toEqual([color('helper'), color('lang')]);
        expect(painter.nodeDot(BOX, ['bugfixer', 'helper', 'lang'])).toBe(
            `  "p" [style="striped", fillcolor="${color('helper')};0.500:${color('lang')}", class="${STRIPED_CLASS}", fontcolor="${DARK_TEXT}", label=<DARK>];\n`,
        );
    });

    it('carries only OFF products: light grey and still drawn', () => {
        const painter = api.painter(palette.colors, ['lang']);
        expect(painter.paint(['bugfixer', 'helper']).kind).toBe('off');
        expect(painter.nodeDot(BOX, ['helper'])).toBe(
            `  "p" [style="filled", fillcolor="${PRODUCT_OFF_FILL}", fontcolor="${DARK_TEXT}", color="${PRODUCT_OFF_BORDER}", label=<DARK>];\n`,
        );
    });

    it('carries no product: white with a dashed border, whatever is ON', () => {
        for (const on of [[], ['lang'], palette.names()]) {
            const painter = api.painter(palette.colors, on);
            expect(painter.paint([]).kind).toBe('none');
            expect(painter.nodeDot(BOX, [])).toBe(
                `  "p" [style="filled,dashed", fillcolor="${PRODUCT_NONE_FILL}", fontcolor="${DARK_TEXT}", color="${PRODUCT_NONE_BORDER}", penwidth=1.5, label=<DARK>];\n`,
            );
        }
    });

    it('is neutral "shared by every product" only while ALL products are ON and the box carries every one', () => {
        const all = api.painter(palette.colors, palette.names());
        expect(all.paint(palette.names()).kind).toBe('shared');
        expect(all.nodeDot(BOX, palette.names())).toContain(`fillcolor="${PRODUCT_SHARED_FILL}"`);
        // All ON, but the box misses one: stripes, never neutral.
        expect(all.paint(['helper', 'lang']).kind).toBe('stripes');
        // The box carries every product, but one is OFF: stripes of the ON ones reveal the overlap.
        const narrowed = api.painter(palette.colors, ['helper', 'lang']);
        expect(narrowed.paint(palette.names()).kind).toBe('stripes');
        expect(narrowed.paint(palette.names()).colors).toEqual([color('helper'), color('lang')]);
    });

    it('a lone product is never "shared by every product": it is its own color', () => {
        const one = new ProductPalette(['lang']);
        expect(api.painter(one.colors, ['lang']).paint(['lang']).kind).toBe('solid');
    });

    it('never reassigns a color: a product keeps its palette color whatever else is ON', () => {
        for (const on of [['lang'], ['bugfixer', 'lang'], palette.names()]) {
            const paint = api.painter(palette.colors, on).paint(['lang']);
            expect(paint.colors).toEqual([color('lang')]);
        }
    });

    it('dashes a cross-product edge in the first ON product it crosses into; plain when none is ON', () => {
        const edge = new RenderEdge('a', 'b', '  "a" -> "b" [id="wp-real-edge-0"];\n', 'wp-real-edge-0', ['helper', 'lang']);
        expect(api.painter(palette.colors, ['lang']).edgeColor(edge.crossesInto)).toBe(color('lang'));
        expect(api.painter(palette.colors, ['helper', 'lang']).edgeDot(edge)).toBe(
            `  "a" -> "b" [id="wp-real-edge-0"] [style=dashed, color="${color('helper')}", penwidth=2];\n`,
        );
        expect(api.painter(palette.colors, ['bugfixer']).edgeColor(edge.crossesInto)).toBeNull();
        expect(api.painter(palette.colors, ['bugfixer']).edgeDot(edge)).toBe(edge.dot);
        const plain = new RenderEdge('a', 'c', '  "a" -> "c";\n', 'wp-real-edge-1');
        expect(api.painter(palette.colors, palette.names()).edgeDot(plain)).toBe(plain.dot);
    });

    it('recolors a contextual node\'s kind statement: a gradient for several ON, grey for OFF, dashed for none', () => {
        const kind = '  "queue__q" [shape=Mrecord, style="filled", fillcolor="#abcdef", label="q"];\n';
        const context = new ProductTemplate(ProductTemplateKind.CONTEXT, kind, '', '');
        const painter = api.painter(palette.colors, ['helper', 'lang']);
        expect(painter.nodeDot(context, ['helper', 'lang'])).toContain(`fillcolor="${color('helper')}:${color('lang')}"`);
        expect(painter.nodeDot(context, ['bugfixer'])).toContain(`fillcolor="${PRODUCT_OFF_FILL}"`);
        expect(painter.nodeDot(context, [])).toContain(`style="filled,dashed", fillcolor="${PRODUCT_NONE_FILL}"`);
        expect(painter.nodeDot(context, ['lang'])).toContain('shape=Mrecord');
    });

    it('writes the same colors and counts graph-products.ts and graph-color-modes.ts declare', () => {
        expect(api.constants).toEqual({
            SHARED_FILL: PRODUCT_SHARED_FILL,
            NONE_FILL: PRODUCT_NONE_FILL,
            NONE_BORDER: PRODUCT_NONE_BORDER,
            OFF_FILL: PRODUCT_OFF_FILL,
            OFF_BORDER: PRODUCT_OFF_BORDER,
            DARK_TEXT,
            LIGHT_TEXT,
            STRIPED_CLASS,
            ON_AT_LOAD: PRODUCTS_ON_AT_LOAD,
        });
    });
});
