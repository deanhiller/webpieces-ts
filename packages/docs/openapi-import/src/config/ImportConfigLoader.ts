import * as path from 'path';
import { OpenApiImportError } from '../OpenApiImportError';
import { JsonFile } from '../spec/JsonFile';
import { SpecNode } from '../spec/SpecNode';
import { ContextKeyRef, ImportConfig } from './ImportConfig';

/** The import file's keys — anything else is refused, so a typo cannot silently mean nothing. */
const KNOWN_KEYS: readonly string[] = ['spec', 'contract', 'auth', 'contextKeys', 'operations'];

/** The class-level entry of `contextKeys`. */
const EVERY_OPERATION = '*';

/** A dotted identifier path: `VendorKeys.MERCHANT_ID`. */
const SYMBOL_PATTERN = /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*$/;

/**
 * Reads and VALIDATES one import file. Every key is required except `contextKeys`; a key the file
 * does not define, a `contextKeys` entry naming an operation that is not in `operations` (a DEAD
 * entry), and a repeated operation are all refused, naming the fix.
 */
export class ImportConfigLoader {
    private readonly json = new JsonFile();

    load(configPath: string): ImportConfig {
        const absolute = path.resolve(configPath);
        const root = this.json.read(absolute, 'import file', 'Pass --config <path to the vendor import JSON>.');
        for (const key of root.keys()) {
            if (!KNOWN_KEYS.includes(key)) {
                throw new OpenApiImportError(
                    `unknown import-file key '${key}'`,
                    absolute,
                    `Remove it; the import file accepts only ${KNOWN_KEYS.join(', ')}.`,
                );
            }
        }
        const spec = this.requiredText(root, 'spec', absolute);
        const contract = this.requiredText(root, 'contract', absolute);
        if (!/^[A-Z][A-Za-z0-9]*$/.test(contract)) {
            throw new OpenApiImportError(
                `contract '${contract}' is not a PascalCase class name`,
                absolute,
                'Name the generated class, e.g. "contract": "VendorApi".',
            );
        }
        const operations = this.operations(root, absolute);
        const contextKeys = this.contextKeys(root, operations, absolute);
        const methodKeys = new Map<string, readonly ContextKeyRef[]>();
        for (const operation of operations) {
            const keys = contextKeys.get(operation);
            if (keys !== undefined) methodKeys.set(operation, keys);
        }
        return new ImportConfig(
            absolute,
            path.resolve(path.dirname(absolute), spec),
            spec,
            contract,
            this.vendorAuth(root, absolute),
            contextKeys.get(EVERY_OPERATION) ?? [],
            methodKeys,
            operations,
        );
    }

    private vendorAuth(root: SpecNode, absolute: string): string {
        const vendorAuth = root.at('auth').text('vendorAuth');
        if (vendorAuth === undefined || vendorAuth.trim() === '' || root.at('auth').keys().length !== 1) {
            throw new OpenApiImportError(
                'auth must be exactly { "vendorAuth": "<name>" }',
                absolute,
                'Name the vendor whose VendorAuthMinter mints the credential, e.g. "auth": { "vendorAuth": "vendor" }.',
            );
        }
        return vendorAuth;
    }

    private requiredText(root: SpecNode, key: string, absolute: string): string {
        const value = root.text(key);
        if (value === undefined || value.trim() === '') {
            throw new OpenApiImportError(`'${key}' is required and must be a non-empty string`, absolute, `Add "${key}".`);
        }
        return value;
    }

    private operations(root: SpecNode, absolute: string): string[] {
        const operations = [...root.texts('operations')];
        if (operations.length === 0 || operations.length !== root.list('operations').length) {
            throw new OpenApiImportError(
                "'operations' must be a non-empty array of operationIds",
                absolute,
                'List every vendor operation the contract should expose, e.g. "operations": ["items.GetItems"].',
            );
        }
        const seen = new Set<string>();
        for (const operation of operations) {
            if (seen.has(operation)) {
                throw new OpenApiImportError(`operation '${operation}' is listed twice`, absolute, 'List each operationId once.');
            }
            seen.add(operation);
        }
        return operations;
    }

    private contextKeys(root: SpecNode, operations: readonly string[], absolute: string): Map<string, ContextKeyRef[]> {
        const node = root.at('contextKeys');
        const result = new Map<string, ContextKeyRef[]>();
        for (const entry of node.keys()) {
            if (entry !== EVERY_OPERATION && !operations.includes(entry)) {
                throw new OpenApiImportError(
                    `contextKeys entry '${entry}' names an operation that is not in 'operations' — a dead entry`,
                    absolute,
                    `Delete the entry, or add '${entry}' to "operations".`,
                );
            }
            result.set(entry, node.list(entry).map((ref: SpecNode) => this.keyRef(ref, entry, absolute)));
        }
        return result;
    }

    private keyRef(ref: SpecNode, entry: string, absolute: string): ContextKeyRef {
        const from = ref.text('from');
        const symbol = ref.text('symbol');
        if (from === undefined || symbol === undefined || !SYMBOL_PATTERN.test(symbol) || ref.keys().length !== 2) {
            throw new OpenApiImportError(
                `contextKeys['${entry}'] holds an entry that is not { "from": "<module>", "symbol": "<Owner.KEY>" }`,
                absolute,
                'Name each key by its module and dotted symbol, e.g. { "from": "@myorg/vendor-keys", "symbol": "VendorKeys.MERCHANT_ID" }.',
            );
        }
        return new ContextKeyRef(from, symbol);
    }
}
