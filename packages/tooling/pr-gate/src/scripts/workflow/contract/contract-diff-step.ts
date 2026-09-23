import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Option, RuleFailError } from '@webpieces/rules-config';
import { injectable, bindingScopeValues } from 'inversify';
import { GitExec } from '../git-exec';
import { ConsumerBin, ConsumerBinRequest, ConsumerBinResolver } from './consumer-bin-resolver';
import { ContractDiffRenderer, ContractDiffSection } from './contract-diff-renderer';
import { GeneratorRun, GeneratorRunner } from './generator-runner';
import { OPENAPI_GENERATE_EXECUTOR, OPENAPI_GENERATOR, PARTNER_DOCUMENT } from './generator-package';
import { JsonObject } from './json-value';
import { OpenApiContractDiff } from './openapi-contract-diff';

const RULE_NAME = 'contract-diff';

/** One project that declared an `openapi-generate` target, and the manifest it names. Data-only. */
export class DeclaredContract {
    constructor(
        readonly projectName: string,
        /** Workspace-relative project root. */
        readonly projectRoot: string,
        /** Workspace-relative manifest path, exactly as the target's `options.manifest` states it. */
        readonly manifest: string,
    ) {}
}

/** Where one side of the diff is generated from and into. Data-only. */
class GenerationSide {
    constructor(
        /** The tree the manifest's relative paths resolve against: the repo, or an extracted merge-base. */
        readonly treeRoot: string,
        readonly outDir: string,
    ) {}
}

/**
 * The PR-gate step that replaced committing generated documents (#986): for every project that
 * declares an `openapi-generate` target, generate the partner-facing document at the MERGE-BASE and at
 * HEAD, diff the two, and render the result as a PR comment.
 *
 * ## Which contracts
 *
 * Exactly the ones a `project.json` declares with the `openapi-generate` executor — the same
 * declaration that makes the build generate and publish the document. There is no second list to keep
 * in step, and a repo that declares none gets no comment and pays nothing.
 *
 * ## One reader, two sources
 *
 * Both sides run the CONSUMER's installed generator (never a bundled copy — see
 * {@link ConsumerBinResolver}). So the diff isolates what the SOURCE changed; a generator upgrade
 * landing in the same PR is not reported as a contract change on every endpoint.
 *
 * The merge-base is extracted with `git archive` INSIDE the repo (under the branch's scratch dir, which
 * is gitignored with the rest of `.webpieces/`), so its imports resolve through the same
 * `node_modules` by walking up — no second install, no worktree bookkeeping for `wp-cleanup` to reap.
 *
 * ## Failure
 *
 * HEAD failing to generate THROWS, before anything is pushed: the build publishes that document, so a
 * contract that cannot be generated is not a PR to post. The merge-base failing is not this PR's defect
 * (today's generator may refuse a shape an older one accepted) — it is REPORTED in the comment, and the
 * diff then reads every HEAD item as added.
 */
@injectable(bindingScopeValues.Singleton)
export class ContractDiffStep {
    constructor(
        private readonly gitExec: GitExec,
        private readonly resolver: ConsumerBinResolver,
        private readonly runner: GeneratorRunner,
        private readonly differ: OpenApiContractDiff,
        private readonly renderer: ContractDiffRenderer,
    ) {}

    /** The comment body, or '' when no project declares a contract. `scratchDir` must be inside the repo. */
    commentBody(repoRoot: string, scratchDir: string): string {
        const contracts = this.declaredContracts(repoRoot);
        if (contracts.length === 0) return '';
        const headSha = this.gitExec.gitQuery(['rev-parse', 'HEAD'], repoRoot, 'git rev-parse HEAD failed');
        const baseSha = this.gitExec.gitQuery(['merge-base', 'origin/main', 'HEAD'], repoRoot, 'git merge-base origin/main HEAD failed');
        fs.rmSync(scratchDir, { recursive: true, force: true });
        const baseTree = path.join(scratchDir, 'merge-base');
        const sections: ContractDiffSection[] = [];
        // webpieces-disable no-unmanaged-exceptions -- try/FINALLY only, nothing is caught: the extracted
        // merge-base tree is removed however this ends, and any throw still reaches the top-level handler
        // eslint-disable-next-line @webpieces/no-unmanaged-exceptions
        try {
            const extracted = this.extractIfNeeded(repoRoot, baseSha, contracts, baseTree);
            contracts.forEach((contract: DeclaredContract, index: number) => {
                const head = new GenerationSide(repoRoot, path.join(scratchDir, 'head', String(index)));
                const base = new GenerationSide(baseTree, path.join(scratchDir, 'base', String(index)));
                sections.push(this.section(repoRoot, contract, extracted, head, base, baseSha, headSha));
            });
        } finally {
            fs.rmSync(scratchDir, { recursive: true, force: true });
        }
        return this.renderer.render(sections);
    }

    /** Every tracked `project.json` target running {@link OPENAPI_GENERATE_EXECUTOR}. */
    declaredContracts(repoRoot: string): DeclaredContract[] {
        const listed = this.gitExec.gitQuery(['ls-files', '--', '*project.json'], repoRoot, 'git ls-files failed');
        const contracts: DeclaredContract[] = [];
        for (const file of listed.split('\n').filter((line: string) => line.trim() !== '').sort()) {
            const project = JSON.parse(fs.readFileSync(path.join(repoRoot, file), 'utf8')) as JsonObject;
            const targets = this.object(project['targets']);
            for (const targetName of Object.keys(targets).sort()) {
                const target = this.object(targets[targetName]);
                const manifest = this.object(target['options'])['manifest'];
                if (target['executor'] !== OPENAPI_GENERATE_EXECUTOR || typeof manifest !== 'string') continue;
                const name = typeof project['name'] === 'string' ? project['name'] : path.dirname(file);
                contracts.push(new DeclaredContract(name, path.dirname(file), manifest));
            }
        }
        return contracts;
    }

    // eslint-disable-next-line @typescript-eslint/max-params
    private section(
        repoRoot: string, contract: DeclaredContract, extracted: boolean,
        head: GenerationSide, base: GenerationSide, baseSha: string, headSha: string,
    ): ContractDiffSection {
        const bin = this.resolver.resolve(new ConsumerBinRequest(
            RULE_NAME, OPENAPI_GENERATOR, [path.join(repoRoot, contract.projectRoot), repoRoot]));
        const headRun = this.generate(bin, contract, head);
        if (!headRun.ok) {
            throw new RuleFailError(
                RULE_NAME,
                `${contract.manifest} does not generate at HEAD, so there is no partner-facing document to ` +
                    `diff or to publish.\n${headRun.output}`,
                undefined,
                undefined,
                [new Option(`Fix the contract, then re-run: pnpm nx run ${contract.projectName}:openapi-generate`, true)],
            );
        }
        const after = this.readDocument(head.outDir);
        let baseNote = '';
        let before: JsonObject | undefined;
        if (!extracted || !fs.existsSync(path.join(base.treeRoot, contract.manifest))) {
            baseNote = 'The merge-base has no such manifest — a new contract, so everything below is new.';
        } else {
            const baseRun = this.generate(bin, contract, base);
            if (baseRun.ok) before = this.readDocument(base.outDir);
            else baseNote = `The merge-base does not generate with ${bin.packageName} ${bin.version}, so every HEAD item reads as added:\n> ${baseRun.output.split('\n').join('\n> ')}`;
        }
        return new ContractDiffSection(
            contract.projectName, contract.manifest, PARTNER_DOCUMENT, baseSha, headSha, baseNote,
            after === undefined, this.differ.diff(before, after));
    }

    private generate(bin: ConsumerBin, contract: DeclaredContract, side: GenerationSide): GeneratorRun {
        fs.mkdirSync(side.outDir, { recursive: true });
        return this.runner.run(bin, [
            '--manifest', path.join(side.treeRoot, contract.manifest), '--out', side.outDir, '--format', 'json',
        ], side.treeRoot);
    }

    private readDocument(outDir: string): JsonObject | undefined {
        const file = path.join(outDir, PARTNER_DOCUMENT);
        return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as JsonObject) : undefined;
    }

    /**
     * Extract the merge-base tree, unless no declared manifest existed there — a PR that ADDS its first
     * contract needs no 14 MB archive to learn that everything is new.
     */
    private extractIfNeeded(repoRoot: string, baseSha: string, contracts: readonly DeclaredContract[], into: string): boolean {
        const anyAtBase = contracts.some((contract: DeclaredContract) =>
            this.gitExec.tryGit(['cat-file', '-e', `${baseSha}:${contract.manifest}`], repoRoot).status === 0);
        if (!anyAtBase) return false;
        fs.mkdirSync(into, { recursive: true });
        const tarFile = `${into}.tar`;
        this.gitExec.gitQuery(['archive', '--format=tar', '-o', tarFile, baseSha], repoRoot, `git archive ${baseSha} failed`);
        const untar = spawnSync('tar', ['-xf', tarFile, '-C', into], { encoding: 'utf8' });
        if (untar.status !== 0) {
            throw new RuleFailError(RULE_NAME, `Could not extract the merge-base ${baseSha} into ${into}: ${untar.stderr ?? ''}`);
        }
        return true;
    }

    private object(value: JsonObject[string] | undefined): JsonObject {
        return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
}
