import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WpOpenApiImportMain } from '../cli/WpOpenApiImportMain';

/** A `process.stdout` stand-in, so the bin's own output is asserted rather than printed. */
class Sink {
    readonly lines: string[] = [];

    asStream(): NodeJS.WriteStream {
        const sink = this;
        return {
            write: (text: string): boolean => {
                sink.lines.push(text);
                return true;
            },
        } as NodeJS.WriteStream;
    }

    text(): string {
        return this.lines.join('');
    }
}

describe('the wp-openapi-import bin', () => {
    it('prints usage for --help and exits 0', () => {
        const sink = new Sink();
        expect(new WpOpenApiImportMain().run(['--help'], process.cwd(), sink.asStream())).toBe(0);
        expect(sink.text()).toContain('Usage: wp-openapi-import --config <vendor.import.json> --out <Contract.generated.ts>');
    });

    it('writes the contract and names the file', () => {
        const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wp-openapi-import-cli-')), 'ShopApi.generated.ts');
        const config = path.join(__dirname, 'fixtures', 'shop', 'shop.import.json');
        const sink = new Sink();
        expect(new WpOpenApiImportMain().run(['--config', config, '--out', out], process.cwd(), sink.asStream())).toBe(0);
        expect(sink.text()).toBe(`wrote ${out}\n`);
        expect(fs.readFileSync(out, 'utf8')).toContain('export abstract class ShopApi');
    });

    it('renders a refusal with its cure and exits 1, writing nothing', () => {
        const sink = new Sink();
        expect(new WpOpenApiImportMain().run(['--config', 'nope.json'], process.cwd(), sink.asStream())).toBe(1);
        expect(sink.text()).toContain('wp-openapi-import refused: --config and --out are both required (command line)');
    });
});
