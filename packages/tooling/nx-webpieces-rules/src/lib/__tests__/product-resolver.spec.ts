/**
 * `product:<name>` tags (#1179): several allowed, lowercase kebab only, a malformed one is a problem
 * naming the project — never silently dropped.
 */
import { describe, it, expect } from 'vitest';
import { ProjectInfo } from '../project-info';
import { ProductResolver } from '../product-resolver';

const resolver = new ProductResolver();
const info = (tags: string[]): ProjectInfo => new ProjectInfo('lang-server', 'apps/lang-server', tags);

describe('ProductResolver', () => {
    it('reads one product tag, ignoring every other tag', () => {
        const resolution = resolver.resolve(info(['role:server', 'framework:node', 'product:lang']));
        expect(resolution.products).toEqual(['lang']);
        expect(resolution.problems).toEqual([]);
    });

    it('allows several products, sorted and de-duplicated', () => {
        const resolution = resolver.resolve(info(['product:helper', 'product:bugfixer', 'product:helper']));
        expect(resolution.products).toEqual(['bugfixer', 'helper']);
    });

    it('accepts lowercase kebab with digits', () => {
        expect(resolver.resolve(info(['product:job-finder2'])).products).toEqual(['job-finder2']);
    });

    it('declares nothing with no product tag', () => {
        const resolution = resolver.resolve(info(['role:lib']));
        expect(resolution.products).toEqual([]);
        expect(resolution.problems).toEqual([]);
    });

    it.each(['product:', 'product:Lang', 'product:lang_app', 'product:-lang', 'product:lang-', 'product:a--b', 'product: lang'])(
        'refuses the malformed %s, naming the project',
        (tag: string) => {
            const resolution = resolver.resolve(info([tag]));
            expect(resolution.products).toEqual([]);
            expect(resolution.problems).toEqual([
                expect.stringContaining(`lang-server: product tag '${tag}' is malformed`),
            ]);
        },
    );

    it('keeps the well-formed tags beside a malformed one', () => {
        const resolution = resolver.resolve(info(['product:lang', 'product:Bad']));
        expect(resolution.products).toEqual(['lang']);
        expect(resolution.problems).toHaveLength(1);
    });
});
