import { SourceSyntax } from '@webpieces/tooling-common/source-syntax';
import { FileContext, ProposedContent, ProposedFile } from '@webpieces/hook-runtime';
import { InformAiError } from '@webpieces/tooling-common';

/** The proposed file's parse, plus the original's on demand (for rules that grandfather unchanged code). */
export class FileSyntax {
    readonly proposed: SourceSyntax;
    private originalSource: SourceSyntax | null = null;

    constructor(private readonly fileName: string, readonly content: ProposedContent) {
        this.proposed = new SourceSyntax(fileName, content.text);
    }

    original(): SourceSyntax {
        if (!this.originalSource) this.originalSource = new SourceSyntax(this.fileName, this.content.original);
        return this.originalSource;
    }
}

/**
 * The shared AST entry point for Write/Edit-time syntax rules. Every rule judging one invocation's file
 * gets the SAME parse: weak keys expire with the invocation's projected file, so nothing outlives it.
 */
export class SourceAnalysis {
    private readonly cache = new WeakMap<ProposedFile, FileSyntax>();

    forFile(ctx: FileContext): FileSyntax {
        if (!ctx.proposedFile) throw new InformAiError('Source syntax rules require the proposed file for a write/edit.');
        const cached = this.cache.get(ctx.proposedFile);
        if (cached) return cached;
        const syntax = new FileSyntax(ctx.filePath, ctx.proposedFile.read());
        this.cache.set(ctx.proposedFile, syntax);
        return syntax;
    }
}

export const sourceAnalysis = new SourceAnalysis();
