import * as fs from 'fs';
import * as path from 'path';
import { describe, it, expect } from 'vitest';

import { GuardIndexDoc, LayerGeneration, LAYER_GENERATION, GUARD_INDEX_BEGIN, GUARD_INDEX_END } from './guard-index-doc';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..', '..');
const INDEX_DOC = path.join(REPO_ROOT, 'GUARD_MATRIX.md');

function committed(): string {
    return fs.readFileSync(INDEX_DOC, 'utf8');
}

/**
 * THE BYTE LOCK, on the file whose whole job is reporting which files are generated.
 *
 * This is the doc that told a reader "every remaining layer file is hand-written TODAY" ten lines above
 * a table listing L2 as generated. Both halves were hand-maintained, L2 was converted, and only one of
 * them was updated. An index that is wrong about generation is worse than no index — you consult it
 * precisely when you do not already know.
 */
describe('GUARD_MATRIX.md — the generated block IS the array', () => {
    it('matches GuardIndexDoc.render() byte for byte', () => {
        expect(new GuardIndexDoc().extract(committed()), 'run `pnpm guards:generate`')
            .toBe(new GuardIndexDoc().render());
    });

    it('carries exactly one marker pair', () => {
        const doc = committed();
        expect(doc.split(GUARD_INDEX_BEGIN).length - 1).toBe(1);
        expect(doc.split(GUARD_INDEX_END).length - 1).toBe(1);
    });

    // The splice is the only writer. Everything OUTSIDE the markers is hand-written prose and must
    // survive byte for byte — that is what makes it safe to keep essays in the same file as data.
    it('preserves every byte outside the markers', () => {
        const doc = committed();
        const spliced = new GuardIndexDoc().splice(doc);
        expect(spliced.slice(0, doc.indexOf(GUARD_INDEX_BEGIN))).toBe(doc.slice(0, doc.indexOf(GUARD_INDEX_BEGIN)));
        expect(spliced.slice(spliced.indexOf(GUARD_INDEX_END))).toBe(doc.slice(doc.indexOf(GUARD_INDEX_END)));
    });

    it('throws rather than silently not splicing when a marker is missing or doubled', () => {
        expect(() => new GuardIndexDoc().extract('no markers here')).toThrow(/exactly one BEGIN\/END marker pair/);
        expect(() => new GuardIndexDoc().extract(`${GUARD_INDEX_BEGIN}\nx\n${GUARD_INDEX_END}\n${GUARD_INDEX_BEGIN}\ny\n${GUARD_INDEX_END}`))
            .toThrow(/exactly one BEGIN\/END marker pair/);
    });
});

describe('the layer statuses it renders from', () => {
    it('covers all five layers, in order, each naming its doc', () => {
        expect(LAYER_GENERATION.map((e: LayerGeneration): string => e.layer)).toEqual(['L0', 'L1', 'L2', 'L3', 'L4']);
        for (const entry of LAYER_GENERATION) {
            expect(fs.existsSync(path.join(REPO_ROOT, entry.doc)), `${entry.layer}: ${entry.doc}`).toBe(true);
        }
    });

    /*
     * The claim and the evidence, joined. A layer that says it is generated must name the array it is
     * generated FROM — that pairing is the thing the old prose could assert without ever being checked.
     */
    it('gives every generated layer a source array, and every hand-written one none', () => {
        for (const entry of LAYER_GENERATION) {
            const claimsGenerated = entry.status.includes('generated');
            expect(entry.source !== '', `${entry.layer} source vs status`).toBe(claimsGenerated);
        }
    });

    it('renders every layer into both tables', () => {
        const rendered = new GuardIndexDoc().render();
        for (const entry of LAYER_GENERATION) {
            expect(rendered, `${entry.layer} status`).toContain(entry.status);
            expect(rendered, `${entry.layer} goal`).toContain(entry.goal);
            expect(rendered, `${entry.layer} doc link`).toContain(entry.doc);
        }
    });

    // The sentence that drifted last time: "One command regenerates all three" outlived the conversion
    // that made it four. It is counted from the array now, so it cannot outlive the next one.
    it('counts the whole-file generated docs rather than stating a number', () => {
        const whole = LAYER_GENERATION.filter((e: LayerGeneration): boolean => e.status.includes('generated whole'));
        expect(new GuardIndexDoc().render()).toContain(`It rewrites the\n${String(whole.length)} whole-file docs`);
    });

    // L0 and L1 have no config key ON PURPOSE, and the doc must not present the absence as an oversight.
    it('says the missing config keys are deliberate', () => {
        const keyless = LAYER_GENERATION.filter((e: LayerGeneration): boolean => e.configKey === '');
        expect(keyless.map((e: LayerGeneration): string => e.layer)).toEqual(['L0', 'L1']);
        for (const entry of keyless) expect(entry.keyCell()).toContain('deliberate');
    });
});
