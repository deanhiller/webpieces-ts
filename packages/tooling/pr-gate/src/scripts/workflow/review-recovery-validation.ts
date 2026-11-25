import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { bindingScopeValues, injectable } from 'inversify';
import { InformAiError } from '@webpieces/tooling-common';
import { RecoveryFile } from './review-recovery-files';

/** Untrusted archived JSON is inspected before any file is admitted into active workflow state. */
@injectable(bindingScopeValues.Singleton)
export class ReviewRecoveryValidation {
    // webpieces-disable no-any-unknown -- parse boundary for archived JSON, each consumer narrows fields
    object(source: string, name: string): Record<string, unknown> {
        const target = path.join(source, name);
        if (!fs.lstatSync(target).isFile())
            throw new InformAiError(`Not a regular recovery file: ${name}`);
        // webpieces-disable no-any-unknown -- JSON is opaque until the shape check below
        const value: unknown = JSON.parse(fs.readFileSync(target, 'utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value))
            throw new InformAiError(`Invalid recovery JSON: ${name}`);
        return value as Record<string, unknown>;
    }
    // webpieces-disable no-any-unknown -- a single archived field, narrowed to nonempty string
    text(value: Record<string, unknown>, key: string): string {
        if (typeof value[key] !== 'string' || !value[key])
            throw new InformAiError(`Missing recovery field: ${key}`);
        return value[key] as string;
    }
    // webpieces-disable no-any-unknown -- an archived string array, rejected rather than coerced
    strings(value: Record<string, unknown>, key: string): string[] {
        const item = value[key];
        if (!Array.isArray(item) || item.some((part): boolean => typeof part !== 'string' || !part))
            throw new InformAiError(`Invalid recovery array: ${key}`);
        return item as string[];
    }
    // webpieces-disable no-any-unknown -- receipt schema is validated field-by-field
    receipt(source: string): Record<string, unknown> {
        const receipt = this.object(source, 'review-stage.json');
        const round = receipt['round'];
        const cap = receipt['maxReviewerRounds'];
        if (
            !Number.isInteger(round) ||
            !Number.isInteger(cap) ||
            Number(round) < 1 ||
            Number(round) > Number(cap)
        )
            throw new InformAiError(
                'Recovery requires an existing valid reviewer round and its original budget',
            );
        if (!/^[a-f0-9]{40}$/.test(this.text(receipt, 'headSha')))
            throw new InformAiError('Invalid historical reviewed SHA');
        const roster = this.strings(receipt, 'reviewersBriefed');
        if (!roster.length || new Set(roster).size !== roster.length)
            throw new InformAiError('Invalid frozen review roster');
        const optional = this.strings(receipt, 'optionalBriefed');
        if (optional.some((id): boolean => !roster.includes(id)))
            throw new InformAiError('Optional roster is not part of frozen roster');
        return receipt;
    }
    // webpieces-disable no-any-unknown -- receipt and provenance fields are checked against one another
    verdicts(source: string, files: RecoveryFile[], receipt: Record<string, unknown>): void {
        const latest = Number(receipt['round']);
        const roster = this.strings(receipt, 'reviewersBriefed');
        const optional = this.strings(receipt, 'optionalBriefed');
        for (const id of roster.filter((id): boolean => !optional.includes(id))) {
            if (!files.some((file): boolean => file.name === `review-round${latest}-${id}.json`))
                throw new InformAiError(
                    `Recovery requires the completed frozen roster: missing ${id}`,
                );
        }
        for (const file of files) {
            const numbered = /^review-round(\d+)-/.exec(file.name);
            if (numbered && (Number(numbered[1]) < 1 || Number(numbered[1]) > latest))
                throw new InformAiError('Recovery artifact exceeds the frozen round budget');
            if (
                file.name.endsWith('.provenance.json') &&
                !files.some(
                    (candidate): boolean =>
                        candidate.name === file.name.replace('.provenance.json', '.json'),
                )
            )
                throw new InformAiError('Recovery refuses orphaned provenance');
            const match = /^review-round(\d+)-([\w-]+)\.json$/.exec(file.name);
            if (!match || match[2] === 'fixes') continue;
            const round = Number(match[1]);
            const id = match[2];
            if (!roster.includes(id))
                throw new InformAiError('Recovery verdict is outside the frozen roster');
            if (round < 1 || round > latest)
                throw new InformAiError('Recovery cannot change the original round budget');
            this.verdict(source, file, round, id, receipt);
        }
    }
    // webpieces-disable no-any-unknown -- canonical review fields, not arbitrary re-serialized input
    private verdict(
        source: string,
        file: RecoveryFile,
        round: number,
        id: string,
        receipt: Record<string, unknown>,
    ): void {
        const verdict = this.object(source, file.name);
        const record = this.object(source, file.name.replace('.json', '.provenance.json'));
        const fields = ['id', 'status', 'agent', 'model', 'output'].map((key): string =>
            this.text(verdict, key),
        );
        const hash = createHash('sha256').update(JSON.stringify(fields)).digest('hex');
        if (
            fields[0] !== id ||
            record['writer'] !== 'wp-write-review' ||
            record['checklistId'] !== id ||
            record['round'] !== round ||
            record['status'] !== fields[1] ||
            record['verdictHash'] !== hash ||
            (record['harness'] !== 'terminal' &&
                (typeof record['agentId'] !== 'string' || !record['agentId']))
        )
            throw new InformAiError(`Recovery rejected invalid verdict/provenance: ${file.name}`);
        if (!['green', 'yellow', 'orange', 'red'].includes(fields[1]))
            throw new InformAiError('Invalid review color');
        if (!/^[a-f0-9]{64}$/.test(this.text(record, 'scopeHash')))
            throw new InformAiError('Invalid historical scope hash');
        if (round === receipt['round']) {
            const scopes = receipt['scopeHashes'];
            if (
                !scopes ||
                typeof scopes !== 'object' ||
                Array.isArray(scopes) ||
                record['headSha'] !== receipt['headSha'] ||
                record['scopeHash'] !== Reflect.get(scopes, id)
            )
                throw new InformAiError(`Historical scope/briefing mismatch: ${id}`);
        }
        if (fields[1] === 'orange') this.orangeFix(source, round, id, this.text(record, 'headSha'));
    }
    private orangeFix(source: string, round: number, id: string, head: string): void {
        const fixes = this.object(source, `review-round${round}-fixes.json`);
        if (
            fixes['fromHead'] !== head ||
            !Array.isArray(fixes['responses']) ||
            !fixes['responses'].some(
                (row): boolean =>
                    row &&
                    row.checklistId === id &&
                    typeof row.resolution === 'string' &&
                    row.resolution.length > 0,
            )
        )
            throw new InformAiError(`Recovery requires the original ORANGE author fix for ${id}`);
    }
}
