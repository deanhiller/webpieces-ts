import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as ts from 'typescript';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocExtractionError } from '../extract/ApiDocExtractionError';
import { ContextKeyHeaderSlot } from '../extract/ContextKeyHeaderFolder';

/**
 * The CONSUMER layout (#1249): a ContextKey defined in a PUBLISHED package is seen only through its
 * `.d.ts`, where declaration emit has dropped the initializer. The header name must be read from the
 * compiled `.js` shipped beside it — otherwise `WebpiecesCoreHeaders.REQUEST_ID`, the header every
 * consumer documents, could never be named.
 *
 * The package is written to a temp directory per run rather than committed: it is exactly what tsc
 * emits, and committing emitted JavaScript would be a second copy of a build output.
 */
const DECLARATIONS = `
import { ContextKey } from './context-key';
export declare class PublishedKeys {
    static readonly REQUEST_ID: ContextKey<string, "untrusted">;
    static readonly ORG_ID: ContextKey<string, "trusted">;
    static readonly IN_PROCESS: ContextKey<string, "untrusted">;
}
export declare class LegacyKeys {
    static readonly TX_ID: ContextKey<string, "untrusted">;
}
`;

/** ES2022 emit for PublishedKeys, down-levelled (assignment) emit for LegacyKeys. */
const COMPILED = `"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LegacyKeys = exports.PublishedKeys = void 0;
const ContextKey_1 = require("./context-key");
class PublishedKeys {
    static REQUEST_ID = ContextKey_1.ContextKey.untrusted('requestId', 'x-request-id',
    /*maskInLogs*/ false,
    /*isLogged*/ true,
    /*responseHeader*/ 'x-request-id',
    /*responseMerge*/ 'first');
    static ORG_ID = ContextKey_1.ContextKey.trusted('orgId', 'hook-verified', 'x-organization-id');
    static IN_PROCESS = ContextKey_1.ContextKey.untrusted('inProcess');
}
exports.PublishedKeys = PublishedKeys;
class LegacyKeys {
}
exports.LegacyKeys = LegacyKeys;
LegacyKeys.TX_ID = ContextKey_1.ContextKey.untrusted('txId', undefined, false, true, 'x-tx-id');
`;

const CONTEXT_KEY_DECLARATION = `
export declare class ContextKey<V, T> {
    readonly __v?: V;
    readonly __t?: T;
    readonly httpHeader?: string;
    readonly responseHeader?: string;
}
`;

const ENTRY = `
import { PublishedKeys, LegacyKeys } from './pkg/keys';
export const REQUEST_ID_KEY = PublishedKeys.REQUEST_ID;
export const TX_KEY = LegacyKeys.TX_ID;
export const IN_PROCESS_KEY = PublishedKeys.IN_PROCESS;
export { PublishedKeys };
`;

const OPTIONS: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.CommonJS,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
};

class PublishedHarness {
    entry = '';

    write(): void {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wp-published-keys-'));
        fs.mkdirSync(path.join(root, 'pkg'));
        fs.writeFileSync(path.join(root, 'pkg', 'keys.d.ts'), DECLARATIONS);
        fs.writeFileSync(path.join(root, 'pkg', 'keys.js'), COMPILED);
        fs.writeFileSync(path.join(root, 'pkg', 'context-key.d.ts'), CONTEXT_KEY_DECLARATION);
        this.entry = path.join(root, 'entry.ts');
        fs.writeFileSync(this.entry, ENTRY);
    }

    header(exportPath: string, slot: ContextKeyHeaderSlot): string {
        return new ApiDocExtractor().extractContextKeyHeader(this.entry, exportPath, slot, OPTIONS);
    }

    failureOf(exportPath: string, slot: ContextKeyHeaderSlot): ApiDocExtractionError | undefined {
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions -- the throw IS what this method returns
        try {
            this.header(exportPath, slot);
            return undefined;
        } catch (err: unknown) {
            //const error = toError(err);
            return err instanceof ApiDocExtractionError ? err : undefined;
        }
    }
}

const harness = new PublishedHarness();

beforeAll(() => {
    harness.write();
});

describe('a ContextKey from a PUBLISHED package (.d.ts + compiled .js)', () => {
    it('reads the responseHeader through a const aliasing the published key', () => {
        expect(harness.header('REQUEST_ID_KEY', ContextKeyHeaderSlot.RESPONSE)).toBe('x-request-id');
    });

    it('reads the httpHeader of a trusted key through a dotted path into the re-exported class', () => {
        expect(harness.header('PublishedKeys.ORG_ID', ContextKeyHeaderSlot.REQUEST)).toBe('x-organization-id');
    });

    it('reads a down-levelled `Class.MEMBER = …` emit too', () => {
        expect(harness.header('TX_KEY', ContextKeyHeaderSlot.RESPONSE)).toBe('x-tx-id');
    });

    it('still refuses a published key that declares no such header, naming it', () => {
        expect(harness.failureOf('TX_KEY', ContextKeyHeaderSlot.REQUEST)?.message).toContain(
            "'TX_KEY' is a ContextKey that declares no httpHeader",
        );
        expect(harness.failureOf('IN_PROCESS_KEY', ContextKeyHeaderSlot.RESPONSE)?.message).toContain(
            "'IN_PROCESS_KEY' is a ContextKey that declares no responseHeader",
        );
    });
});
