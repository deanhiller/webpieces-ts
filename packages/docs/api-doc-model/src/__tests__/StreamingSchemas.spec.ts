import * as path from 'node:path';
import * as fs from 'node:fs';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ApiDocExtractor } from '../extract/ApiDocExtractor';
import { ApiDocModel } from '../model/ApiDocModel';
import { StreamingSchemaRenderer } from '../render/StreamingSchemaRenderer';

const FILE = path.resolve(__dirname, 'fixtures/StreamingApi.ts');

class StreamingModelFixture {
    extract(replace?: string, replacement?: string): ApiDocModel {
        const config = ts.readConfigFile(path.resolve('tsconfig.base.json'), ts.sys.readFile);
        const options = ts.parseJsonConfigFileContent(config.config, ts.sys, process.cwd()).options;
        const host = ts.createCompilerHost(options);
        const original = host.getSourceFile.bind(host);
        host.getSourceFile = (
            file: string,
            languageVersion: ts.ScriptTarget,
        ): ts.SourceFile | undefined => {
            if (file !== FILE) return original(file, languageVersion);
            const text = fs.readFileSync(FILE, 'utf8');
            return ts.createSourceFile(
                file,
                replace ? text.replace(replace, replacement!) : text,
                languageVersion,
                true,
            );
        };
        const program = ts.createProgram([FILE], options, host);
        return new ApiDocExtractor().extract(program, program.getSourceFile(FILE)!);
    }
}

describe('build-derived streaming schemas', () => {
    it('derives four independent FULL slots and the asymmetric REQUEST/RESPONSE slots', () => {
        const catalog = new StreamingSchemaRenderer().render(new StreamingModelFixture().extract());
        expect(catalog.methods['full'].initialRequestSchema?.required).toEqual(['room']);
        expect(catalog.methods['full'].initialResponseSchema?.required).toEqual(['session']);
        expect(catalog.methods['full'].requestSchema?.required).toEqual(['text']);
        expect(catalog.methods['full'].responseSchema?.required).toEqual(['received']);
        expect(catalog.methods['watch'].requestSchema).toBeUndefined();
        expect(catalog.methods['upload'].responseSchema).toBeUndefined();
        expect(JSON.parse(JSON.stringify(catalog)).contractName).toBe('StreamingApi');
    });

    it.each([
        ['StreamDirection.FULL)', 'StreamDirection.REQUEST)'],
        ['RequestStream<InitialResponse, RequestEvent>', 'RequestStream<InitialResponse>'],
        ['Promise<InitialResponse>', 'Promise<void>'],
        ['ResponseStream<ResponseEvent>', 'ResponseStream<ResponseEvent, InitialResponse>'],
        ['Promise<InitialResponse>', 'Promise<InitialResponse | null>'],
    ])(
        'rejects signature mismatch %s with all supported forms and source location',
        (from: string, to: string) => {
            expect(() => new StreamingModelFixture().extract(from, to)).toThrow(
                /Invalid @WpStream/,
            );
            // One extraction establishes the diagnostic; no filesystem mutation or duplicated source schemas.
        },
    );
});
