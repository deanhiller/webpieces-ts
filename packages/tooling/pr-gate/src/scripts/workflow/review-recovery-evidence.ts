import * as path from 'path';
import { bindingScopeValues, injectable } from 'inversify';
import { isPathExcluded } from '@webpieces/rules-config';
import { GitProcessApi, InformAiError } from '@webpieces/tooling-common';
import { RecoveryFile } from './review-recovery-files';
import { ReviewRecoveryValidation } from './review-recovery-validation';
import { ChecklistScopeHasher } from './checklist-scope-hasher';
import { DiffBasis } from './diff-basis';
import {
    DiffManifest,
    DiffManifestEntry,
    DiffMaterializer,
    FILE_DIFF_MAX_BYTES,
} from './diff-materializer';

export class RecoveryEvidenceBinding {
    constructor(
        readonly artifact: string,
        readonly base: string,
        readonly head: string,
    ) {}
}

/** Required materialization is authenticated independently of the immutable reviewed scope. */
@injectable(bindingScopeValues.Singleton)
export class ReviewRecoveryEvidence {
    constructor(
        private readonly validation: ReviewRecoveryValidation,
        private readonly git: GitProcessApi,
        private readonly materializer: DiffMaterializer,
        private readonly scopes: ChecklistScopeHasher,
    ) {}

    async validate(
        root: string,
        slug: string,
        files: RecoveryFile[],
        published: string,
        // webpieces-disable no-any-unknown -- receipt fields were narrowed by the recovery validator
        receipt: Record<string, unknown>,
    ): Promise<RecoveryEvidenceBinding[]> {
        const reviewed = this.validation.text(receipt, 'headSha');
        const manifest = this.document(files, 'diff/manifest.json');
        const base = this.sha(manifest, 'base');
        const head = this.sha(manifest, 'head');
        if (
            manifest['hashForkPoint'] !== base ||
            manifest['hashFeatureHead'] !== head ||
            manifest['dirty'] !== false
        )
            throw new InformAiError(
                'Historical diff manifest has contradictory identity or dirty state',
            );
        const bindings = [new RecoveryEvidenceBinding('diff/manifest.json', base, head)];
        for (const name of ['pr-context.json', 'stages/stage2-review.json']) {
            const context = this.document(files, name);
            bindings.push(
                new RecoveryEvidenceBinding(
                    name,
                    this.sha(context, 'base'),
                    this.sha(context, 'head'),
                ),
            );
            if (context['dirty'] !== false)
                throw new InformAiError(`Dirty historical context: ${name}`);
        }
        await this.ancestor(root, base, reviewed);
        for (const binding of bindings) await this.lineage(root, binding, reviewed, published);
        const originalDiff = await this.materializer.diffByFile(
            root,
            new DiffBasis(base, reviewed),
        );
        await this.contextInventories(root, files, bindings, base, reviewed, originalDiff);
        const originalConfig = await this.config(root, reviewed);
        this.originalScopes(files, receipt, originalConfig, originalDiff);
        const actualDiff =
            head === reviewed
                ? originalDiff
                : await this.materializer.diffByFile(root, new DiffBasis(base, head));
        const entries = this.manifestFiles(files, manifest, slug, actualDiff);
        this.combined(files, manifest, entries, base, head);
        for (const id of this.validation.strings(receipt, 'reviewersBriefed')) {
            const binding = this.instruction(files, id, receipt);
            await this.lineage(root, binding, reviewed, published);
            const diff =
                binding.base === base && binding.head === head
                    ? actualDiff
                    : await this.materializer.diffByFile(
                          root,
                          new DiffBasis(binding.base, binding.head),
                      );
            const config =
                binding.head === reviewed ? originalConfig : await this.config(root, binding.head);
            this.instructionScope(files, id, config, diff);
            bindings.push(binding);
        }
        return bindings;
    }
    private async contextInventories(
        root: string,
        files: RecoveryFile[],
        bindings: RecoveryEvidenceBinding[],
        base: string,
        reviewed: string,
        originalDiff: Map<string, string>,
    ): Promise<void> {
        for (const binding of bindings.filter((item) => item.artifact !== 'diff/manifest.json')) {
            const context = this.document(files, binding.artifact);
            const diff =
                binding.base === base && binding.head === reviewed
                    ? originalDiff
                    : await this.materializer.diffByFile(
                          root,
                          new DiffBasis(binding.base, binding.head),
                      );
            if (
                JSON.stringify(this.validation.strings(context, 'changedFiles').sort()) !==
                JSON.stringify([...diff.keys()].sort())
            )
                throw new InformAiError(
                    `Historical context inventory contradicts immutable Git: ${binding.artifact}`,
                );
        }
    }
    private async lineage(
        root: string,
        binding: RecoveryEvidenceBinding,
        reviewed: string,
        published: string,
    ): Promise<void> {
        await this.ancestor(root, binding.base, binding.head);
        await this.ancestor(root, reviewed, binding.head);
        await this.ancestor(root, binding.head, published);
    }
    private async ancestor(root: string, from: string, to: string): Promise<void> {
        if (from === to) return;
        const result = await this.git.run(['merge-base', '--is-ancestor', from, to], root);
        if (!result.ok)
            throw new InformAiError(
                `Historical evidence is outside reviewed-to-published lineage: ${from} -> ${to}`,
            );
    }
    private async config(root: string, head: string): Promise<HistoricalChecklists> {
        const result = await this.git.run(['show', `${head}:webpieces.config.json`], root);
        if (!result.ok)
            throw new InformAiError(
                `Cannot authenticate historical checklist configuration at ${head}`,
            );
        const config = this.validation.parse(
            result.stdout,
            'historical Git checklist configuration',
        );
        const commands = this.validation.record(config['commands'], 'historical commands');
        const gate = this.validation.record(commands['pr-gate'], 'historical PR gate');
        if (!Array.isArray(gate['checklists']))
            throw new InformAiError('Missing historical checklist definitions');
        return new HistoricalChecklists(
            gate['checklists'].map((row) => this.validation.record(row, 'historical checklist')),
        );
    }
    private originalScopes(
        files: RecoveryFile[],
        // webpieces-disable no-any-unknown -- validated receipt and immutable Git configuration
        receipt: Record<string, unknown>,
        config: HistoricalChecklists,
        diff: Map<string, string>,
    ): void {
        const hashes = this.validation.record(receipt['scopeHashes'], 'original scope hashes');
        for (const id of this.validation.strings(receipt, 'reviewersBriefed')) {
            const expected = this.scopes.hashOf(this.scope(id, config, diff), diff);
            if (hashes[id] !== expected)
                throw new InformAiError(
                    `Immutable Git review scope does not match original receipt: ${id}`,
                );
        }
        if (!files.some((file) => file.name === 'diff/ALL.diff'))
            throw new InformAiError('Missing required historical artifact: diff/ALL.diff');
    }
    private scope(id: string, config: HistoricalChecklists, diff: Map<string, string>): string[] {
        const row = config.entries.find((item) => item['id'] === id);
        if (!row)
            throw new InformAiError(
                `Frozen checklist ${id} is absent from historical Git configuration`,
            );
        const patterns =
            row['patterns'] === undefined ? [] : this.validation.strings(row, 'patterns');
        return [...diff.keys()].filter(
            (file) => patterns.length === 0 || isPathExcluded(file, patterns),
        );
    }
    private manifestFiles(
        files: RecoveryFile[],
        // webpieces-disable no-any-unknown -- materialization metadata is validated field-by-field
        manifest: Record<string, unknown>,
        slug: string,
        actual: Map<string, string>,
    ): DiffManifestEntry[] {
        if (!Array.isArray(manifest['entries']))
            throw new InformAiError('Missing historical diff manifest entries');
        const entries = manifest['entries'].map((value): DiffManifestEntry => {
            const row = this.validation.record(value, 'historical diff entry');
            const file = this.validation.text(row, 'file');
            const diffFile = this.validation.text(row, 'diffFile');
            const prefix = `.webpieces/pr-review/${slug}/`;
            const relative = diffFile.slice(prefix.length);
            if (
                !diffFile.startsWith(prefix + 'diff/files/') ||
                path.posix.normalize(relative) !== relative ||
                relative.includes('\\') ||
                path.posix.isAbsolute(file) ||
                path.posix.normalize(file) !== file ||
                file.startsWith('../')
            )
                throw new InformAiError(
                    'Historical diff manifest has an unsafe or wrong-branch path',
                );
            const body = this.read(files, relative);
            const status = this.validation.text(row, 'status');
            if (
                row['bytes'] !== body.length ||
                typeof row['truncated'] !== 'boolean' ||
                !actual.has(file)
            )
                throw new InformAiError(`Historical patch contradicts manifest: ${file}`);
            const raw = actual.get(file)!;
            if (
                !['M', 'A', 'D', 'X'].includes(status) ||
                row['truncated'] !== (status !== 'X' && raw.length > FILE_DIFF_MAX_BYTES)
            )
                throw new InformAiError(
                    `Contradictory historical patch status/truncation: ${file}`,
                );
            const expected =
                status === 'X'
                    ? `[excluded from materialization by pr-gate.reviewDiffExclude]\nIf you need it:  git diff ${manifest['base']} -- ${file}\n`
                    : this.materializer.capped(raw, file, this.validation.text(manifest, 'base'));
            if (
                this.scopes.hashOf([file], new Map([[file, body]])) !==
                this.scopes.hashOf([file], new Map([[file, expected]]))
            )
                throw new InformAiError(
                    `Materialized patch differs from immutable Git evidence: ${file}`,
                );
            return new DiffManifestEntry('', file, diffFile, status, body.length, row['truncated']);
        });
        if (
            new Set(entries.map((entry) => entry.file)).size !== entries.length ||
            entries.length !== actual.size
        )
            throw new InformAiError('Historical manifest is missing or duplicates changed files');
        return entries;
    }
    private combined(
        files: RecoveryFile[],
        // webpieces-disable no-any-unknown -- bounded validated manifest arrays
        manifest: Record<string, unknown>,
        entries: DiffManifestEntry[],
        base: string,
        head: string,
    ): void {
        const excluded = this.validation.strings(manifest, 'excluded');
        if (
            JSON.stringify([...excluded].sort()) !==
            JSON.stringify(
                entries
                    .filter((entry) => entry.status === 'X')
                    .map((entry) => entry.file)
                    .sort(),
            )
        )
            throw new InformAiError('Contradictory historical excluded-file inventory');
        const omitted = this.validation.strings(manifest, 'omittedFromAllDiff');
        if (omitted.some((file) => !entries.some((entry) => entry.file === file)))
            throw new InformAiError('Unknown omitted historical patch');
        const data = new DiffManifest(base, head, false, '', entries);
        data.omittedFromAllDiff = omitted;
        const parts = [...entries]
            .sort((a, b) => a.bytes - b.bytes)
            .filter((entry) => !omitted.includes(entry.file))
            .map((entry) => this.read(files, 'diff/files/' + path.posix.basename(entry.diffFile)));
        const all = this.read(files, 'diff/ALL.diff');
        if (
            all !== this.materializer.allDiffHeader(data) + parts.join('\n') ||
            manifest['allDiffBytes'] !== all.length ||
            manifest['allDiffLines'] !== (all === '' ? 0 : all.split('\n').length)
        )
            throw new InformAiError(
                'Historical combined diff contradicts its manifest/per-file patches',
            );
    }
    private instruction(
        files: RecoveryFile[],
        id: string,
        // webpieces-disable no-any-unknown -- original frozen round metadata
        receipt: Record<string, unknown>,
    ): RecoveryEvidenceBinding {
        const name = `instructions/${id}.instructions.md`;
        const text = this.read(files, name);
        const base = /fork point\s+\(A\)\s+([a-f0-9]{40})/.exec(text)?.[1];
        const head = /feature head\s+\(B\)\s+([a-f0-9]{40})/.exec(text)?.[1];
        if (
            !base ||
            !head ||
            !text.includes(`# Checklist \`${id}\``) ||
            !text.includes(
                `Global reviewer round ${receipt['round']} of ${receipt['maxReviewerRounds']}.`,
            ) ||
            !text.includes(`.webpieces/pr-review/${this.sourceSlug(files)}/diff/manifest.json`)
        )
            throw new InformAiError(
                `Historical instructions have contradictory identity/round/context: ${id}`,
            );
        return new RecoveryEvidenceBinding(name, base, head);
    }
    private instructionScope(
        files: RecoveryFile[],
        id: string,
        config: HistoricalChecklists,
        diff: Map<string, string>,
    ): void {
        const text = this.read(files, `instructions/${id}.instructions.md`);
        const rows = [...text.matchAll(/^\| `([^`]+)` \| `[MADUX]` \|/gm)].map((match) => match[1]);
        const expected = this.scope(id, config, diff).sort();
        if (JSON.stringify([...rows].sort()) !== JSON.stringify(expected))
            throw new InformAiError(
                `Historical instruction scope contradicts immutable Git configuration: ${id}`,
            );
    }
    private sourceSlug(files: RecoveryFile[]): string {
        const manifest = this.document(files, 'diff/manifest.json');
        const entries = manifest['entries'];
        if (!Array.isArray(entries) || !entries.length)
            throw new InformAiError('Empty historical manifest');
        const row = this.validation.record(entries[0], 'historical diff entry');
        const match = /^\.webpieces\/pr-review\/([^/]+)\/diff\//.exec(
            this.validation.text(row, 'diffFile'),
        );
        if (!match) throw new InformAiError('Missing historical branch identity');
        return match[1];
    }
    private read(files: RecoveryFile[], name: string): string {
        const file = files.find((item) => item.name === name);
        if (!file) throw new InformAiError(`Missing required historical artifact: ${name}`);
        return file.bytes.toString('utf8');
    }
    // webpieces-disable no-any-unknown -- archived JSON is parsed by the shared validator
    private document(files: RecoveryFile[], name: string): Record<string, unknown> {
        return this.validation.parse(this.read(files, name), name);
    }
    // webpieces-disable no-any-unknown -- commit identity from untrusted evidence
    private sha(value: Record<string, unknown>, key: string): string {
        const sha = this.validation.text(value, key);
        if (!/^[a-f0-9]{40}$/.test(sha)) throw new InformAiError(`Invalid historical ${key} SHA`);
        return sha;
    }
}

class HistoricalChecklists {
    // webpieces-disable no-any-unknown -- historical JSON narrowed by ReviewRecoveryValidation
    constructor(readonly entries: Record<string, unknown>[]) {}
}
