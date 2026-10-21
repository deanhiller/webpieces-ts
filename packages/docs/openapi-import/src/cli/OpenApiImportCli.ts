import * as fs from 'fs';
import * as path from 'path';
import { OpenApiImportError } from '../OpenApiImportError';
import { OpenApiImporter } from '../OpenApiImporter';

export const USAGE = [
    'Usage: wp-openapi-import --config <vendor.import.json> --out <Contract.generated.ts>',
    '',
    'Generates a webpieces EXTERNAL_OUTBOUND contract — an @ApiPath class plus every DTO class and',
    'string enum its operations reach — from a vendor OpenAPI 3.0/3.1 JSON spec and an import file:',
    '',
    '  {',
    '    "spec": "spec/vendor-openapi.json",',
    '    "contract": "VendorApi",',
    '    "auth": { "vendorAuth": "vendor" },',
    '    "contextKeys": { "*": [{ "from": "@myorg/vendor-keys", "symbol": "VendorKeys.MERCHANT_ID" }] },',
    '    "operations": ["items.GetItems", "orders.DeleteOrder"]',
    '  }',
    '',
    'The output is 100% generated and byte-identical on regeneration: never edit it, re-run this.',
].join('\n');

/** Parsed arguments: both are required. */
class CliArgs {
    constructor(
        readonly config: string,
        readonly out: string,
    ) {}
}

/** The whole command minus the process: parse arguments, generate, write the file. */
export class OpenApiImportCli {
    wantsHelp(argv: readonly string[]): boolean {
        return argv.includes('--help') || argv.includes('-h');
    }

    /** @returns the absolute path written. */
    run(argv: readonly string[], cwd: string): string {
        const args = this.parse(argv);
        const configPath = path.resolve(cwd, args.config);
        const out = path.resolve(cwd, args.out);
        const source = new OpenApiImporter().generate(configPath);
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, source);
        return out;
    }

    private parse(argv: readonly string[]): CliArgs {
        const values = new Map<string, string>();
        for (let index = 0; index < argv.length; index += 2) {
            const flag = argv[index];
            const value = argv[index + 1];
            if ((flag !== '--config' && flag !== '--out') || value === undefined || value.startsWith('--')) {
                throw new OpenApiImportError(`unexpected argument '${flag}'`, 'command line', USAGE.split('\n')[0]);
            }
            values.set(flag, value);
        }
        const config = values.get('--config');
        const out = values.get('--out');
        if (config === undefined || out === undefined) {
            throw new OpenApiImportError('--config and --out are both required', 'command line', USAGE.split('\n')[0]);
        }
        return new CliArgs(config, out);
    }
}
