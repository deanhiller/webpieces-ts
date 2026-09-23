import { describe, it, expect } from 'vitest';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { RepoRootFinder, RuleFailError, specTempDirs } from '@webpieces/rules-config';
import { GitExec } from '../git-exec';
import { GitStatusParser } from '../git-status';
import { ConsumerBinResolver } from './consumer-bin-resolver';
import { ContractDiffRenderer } from './contract-diff-renderer';
import { ContractDiffStep } from './contract-diff-step';
import { GeneratorRunner } from './generator-runner';
import { OPENAPI_GENERATE_EXECUTOR } from './generator-package';
import { OpenApiContractDiff } from './openapi-contract-diff';

/**
 * A stand-in `wp-openapi`: it "generates" by copying the `doc.json` beside the manifest to
 * `public-openapi.json`, and refuses when that document says FAIL. That is all this step needs of a
 * generator — the real one is exercised end to end by partner-api's golden spec.
 */
const FAKE_BIN = [
    "const fs = require('fs'); const path = require('path');",
    'const argv = process.argv.slice(2);',
    "const value = (flag) => argv[argv.indexOf(flag) + 1];",
    "const doc = fs.readFileSync(path.join(path.dirname(value('--manifest')), 'doc.json'), 'utf8');",
    "if (doc.includes('FAIL')) { console.log('wp-openapi refused: FAIL'); process.exit(1); }",
    "fs.mkdirSync(value('--out'), { recursive: true });",
    "fs.writeFileSync(path.join(value('--out'), 'public-openapi.json'), doc);",
].join('\n');

/** A throwaway repo with a fake generator installed and `origin/main` pointing at its first commit. */
class ContractRepo {
    readonly root = fs.realpathSync(specTempDirs.make('wp-contract-diff-'));

    constructor() {
        this.git('init', '-q', '-b', 'main');
        this.git('config', 'user.email', 'spec@example.com');
        this.git('config', 'user.name', 'spec');
        this.write('.gitignore', 'node_modules/\n.webpieces/\n');
        const pkg = path.join('node_modules', '@webpieces', 'openapi-generator');
        this.write(path.join(pkg, 'package.json'), JSON.stringify({ version: '0.4.810', bin: { 'wp-openapi': 'bin.js' } }));
        this.write(path.join(pkg, 'bin.js'), FAKE_BIN);
    }

    declareContract(document: object): void {
        this.write('apps/partner/project.json', JSON.stringify({
            name: 'partner',
            targets: { 'openapi-generate': { executor: OPENAPI_GENERATE_EXECUTOR, options: { manifest: 'apps/partner/openapi.manifest.json', format: 'json' } } },
        }));
        this.write('apps/partner/openapi.manifest.json', '{}');
        this.setDocument(document);
    }

    setDocument(document: object | string): void {
        this.write('apps/partner/doc.json', typeof document === 'string' ? document : JSON.stringify(document));
    }

    commit(message: string): void {
        this.git('add', '-A');
        this.git('commit', '-q', '-m', message);
    }

    markMergeBase(): void {
        this.git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    }

    comment(): string {
        const step = new ContractDiffStep(
            new GitExec(new RepoRootFinder(), new GitStatusParser()), new ConsumerBinResolver(),
            new GeneratorRunner(), new OpenApiContractDiff(), new ContractDiffRenderer());
        return step.commentBody(this.root, path.join(this.root, '.webpieces', 'contract-diff'));
    }

    private write(relative: string, content: string): void {
        fs.mkdirSync(path.dirname(path.join(this.root, relative)), { recursive: true });
        fs.writeFileSync(path.join(this.root, relative), content);
    }

    private git(...args: string[]): void {
        execFileSync('git', args, { cwd: this.root, stdio: 'ignore' });
    }
}

const ORDERS = { paths: { '/orders/fetch': { post: { operationId: 'fetchOrders' } } } };
const ORDERS_AND_REINDEX = {
    paths: { '/orders/fetch': { post: { operationId: 'fetchOrders' } }, '/orders/reindex': { post: { operationId: 'reindex' } } },
};

describe('ContractDiffStep', () => {
    it('posts nothing when no project declares an openapi-generate target', () => {
        const repo = new ContractRepo();
        repo.commit('empty');
        repo.markMergeBase();
        expect(repo.comment()).toBe('');
    });

    it('generates at the merge-base AND at HEAD, and names the endpoint that became partner-visible', () => {
        const repo = new ContractRepo();
        repo.declareContract(ORDERS);
        repo.commit('base');
        repo.markMergeBase();
        repo.setDocument(ORDERS_AND_REINDEX);
        repo.commit('expose reindex');

        const body = repo.comment();

        expect(body).toContain('### `partner` — `public-openapi.json`');
        expect(body).toContain('**Added — newly visible to partners**');
        expect(body).toContain('- `POST /orders/reindex`');
        expect(body).not.toContain('POST /orders/fetch');
        // The merge-base tree is scratch: nothing of it is left behind.
        expect(fs.existsSync(path.join(repo.root, '.webpieces', 'contract-diff'))).toBe(false);
    });

    it('says a contract is NEW when the merge-base has no such manifest', () => {
        const repo = new ContractRepo();
        repo.commit('empty');
        repo.markMergeBase();
        repo.declareContract(ORDERS);
        repo.commit('first contract');

        const body = repo.comment();

        expect(body).toContain('a new contract');
        expect(body).toContain('- `POST /orders/fetch`');
    });

    it('reports — does not fail on — a merge-base that no longer generates', () => {
        const repo = new ContractRepo();
        repo.declareContract({});
        repo.setDocument('FAIL');
        repo.commit('base that today\'s generator refuses');
        repo.markMergeBase();
        repo.setDocument(ORDERS);
        repo.commit('fixed');

        const body = repo.comment();

        expect(body).toContain('The merge-base does not generate with @webpieces/openapi-generator 0.4.810');
        expect(body).toContain('wp-openapi refused: FAIL');
        expect(body).toContain('- `POST /orders/fetch`');
    });

    it('REFUSES when HEAD does not generate — there would be nothing to publish', () => {
        const repo = new ContractRepo();
        repo.declareContract(ORDERS);
        repo.commit('base');
        repo.markMergeBase();
        repo.setDocument('FAIL');
        repo.commit('broken');

        expect(() => repo.comment()).toThrow(RuleFailError);
        expect(() => repo.comment()).toThrow(/does not generate at HEAD[\s\S]*wp-openapi refused: FAIL/);
    });
});
