import * as fs from 'fs';
import * as path from 'path';

import { BranchMutationLog } from './branch-mutation-log';
import { MERGE_PROCESS_DOC, MergeProcessText, ReferenceMergeRun } from './merge-process-doc';

// ---------------------------------------------------------------------------
// THE INSTRUCT-AI DOCS ARE WRITTEN AS A SET, NEVER ONE BY ONE.
//
// The bug this fixes: `webpieces.git-workflow.md` links to `webpieces.mergeprocess.md`, and six of the
// nine governed repos had the first file and not the second — the link pointed at nothing. Nobody
// forgot on purpose. Each `wp-*` command named the ONE doc it cared about
// (`writeTemplate(root, 'webpieces.git-workflow.md')`), and a doc that only some other code path wrote
// simply never arrived.
//
// Adding `webpieces.mergeprocess.md` to those six call sites would fix that one link and nothing else:
// the NEXT doc to gain a sibling link would go missing the same way. So the fix is structural — a doc
// is never written alone. Writing one writes the TRANSITIVE CLOSURE of the instruct-ai docs it links
// to, so a doc and everything it points at always land together.
//
// TWO CONSEQUENCES WORTH SPELLING OUT:
//
//   • THE SET IS THE TEMPLATES DIRECTORY. Membership is `readdirSync(templates/)`, not a hand-kept
//     array — dropping `webpieces.<something>.md` into that directory enrols it, and there is no
//     second place to remember. That is the same reason L1/L2 render their tables from the array the
//     guard dispatches on rather than from a description of it.
//   • `instruct-ai-docs.spec.ts` FAILS THE BUILD if any template references a `webpieces.*.md` sibling
//     that is not a member. Without that test this is one instance fixed, not the class.
// ---------------------------------------------------------------------------

const TEMPLATES_DIR = path.join(__dirname, '..', 'templates');

/** Every `webpieces.*.md` name mentioned anywhere in a doc's body — links, prose, code fences alike. */
const DOC_REFERENCE = /webpieces\.[A-Za-z0-9._-]*\.md/g;

/**
 * One deliverable instruct-ai doc.
 *
 * The default is a byte-for-byte copy of its template, rewritten whenever the bytes change. A doc that
 * needs rendering, or that must not clobber live run state, overrides one of the two methods below.
 */
export class InstructAiDoc {
    constructor(readonly name: string) {}

    /**
     * The bytes to deliver, given the template's own bytes and the ROOT of the tree they are being
     * written into.
     *
     * `root` is not decoration: every webpieces state path is per-tree (a linked worktree's state lives
     * under `<primary>/.webpieces/worktrees/<name>/`), so a doc that names one must RESOLVE it for the
     * tree the reader is standing in. A template that restated a relative path instead shipped a path
     * that does not exist in a worktree — see `GitWorkflowDoc`.
     */
    render(templateText: string, root: string): string {
        void root;
        return templateText;
    }

    /**
     * True when an EXISTING copy must be left alone.
     *
     * Only docs a `wp-*` command stamps with live run state say yes: overwriting one mid-run would
     * replace the handback an agent is reading with a generic reference copy.
     */
    seedOnly(): boolean {
        return false;
    }
}

/**
 * `webpieces.mergeprocess.md` — delivered as the reference rendering, never over a live handback.
 *
 * See merge-process-doc.ts for why one template with two inputs is the whole point.
 */
export class MergeProcessDoc extends InstructAiDoc {
    constructor() {
        super(MERGE_PROCESS_DOC);
    }

    override render(templateText: string, root: string): string {
        void root;
        return new MergeProcessText(templateText).render(new ReferenceMergeRun());
    }

    override seedOnly(): boolean {
        return true;
    }
}

/** The rules-config template name, and the file name it lands under in `.webpieces/instruct-ai/`. */
export const GIT_WORKFLOW_DOC = 'webpieces.git-workflow.md';

/**
 * `webpieces.git-workflow.md` — the one doc that names the branch-mutation log by path.
 *
 * It used to restate `.webpieces/logs/branch-mutations.log` as a literal. That log is deliberately
 * PER-WORKTREE (one appender each), so in a linked worktree the literal names a file that does not
 * exist: the reader greps nothing, and the silence reads as "no deletions were logged" — the exact
 * opposite of the truth, from the one file whose job is to prove every deletion is recoverable.
 *
 * So the template carries `{{BRANCH_MUTATION_LOG}}` and this class fills it from the SAME resolver the
 * writer uses, for the tree the doc is being written into. There is one answer to "where is that log",
 * and it is `BranchMutationLog.branchMutationLogPath`.
 */
export class GitWorkflowDoc extends InstructAiDoc {
    constructor(private readonly mutationLog: BranchMutationLog = new BranchMutationLog()) {
        super(GIT_WORKFLOW_DOC);
    }

    override render(templateText: string, root: string): string {
        return templateText.replace(/\{\{BRANCH_MUTATION_LOG\}\}/g, this.mutationLog.branchMutationLogPath(root));
    }
}

/**
 * The set of instruct-ai docs, and the link graph over them.
 *
 * Constructed from the templates directory, so the set cannot disagree with what ships.
 */
export class InstructAiDocSet {
    constructor(private readonly mutationLog: BranchMutationLog = new BranchMutationLog()) {}

    // Resolved on FIRST USE, never in the constructor. `TemplateWriter` is constructed at module load
    // (its migration delegators), and a spec that mocks `fs` for its own subject would otherwise blow up
    // on an unrelated package's import — which is exactly what happened to read-stale-guard.spec.ts.
    private byName: Map<string, InstructAiDoc> | null = null;

    /** Every `webpieces.*.md` template that ships with this package. */
    templateNames(): readonly string[] {
        return fs.readdirSync(TEMPLATES_DIR)
            .filter((name: string): boolean => name.startsWith('webpieces.') && name.endsWith('.md'))
            .sort();
    }

    /** Every member, in name order. */
    all(): readonly InstructAiDoc[] {
        return [...this.members().values()];
    }

    /** The member called `name`, or null when `name` is not an instruct-ai doc at all. */
    get(name: string): InstructAiDoc | null {
        return this.members().get(name) ?? null;
    }

    /** Every `webpieces.*.md` name `text` mentions, member or not, de-duplicated in first-seen order. */
    referencesIn(text: string): readonly string[] {
        return [...new Set(text.match(DOC_REFERENCE) ?? [])];
    }

    /** The references in `text` that are NOT members — what the link-integrity test refuses. */
    danglingIn(text: string): readonly string[] {
        const members = this.members();
        return this.referencesIn(text).filter((name: string): boolean => !members.has(name));
    }

    // The set, built once from the templates directory. The overrides are the docs that need rendering
    // or that must not clobber live run state; everything else is a plain copy of its template.
    private members(): Map<string, InstructAiDoc> {
        if (this.byName !== null) return this.byName;
        const overrides = new Map<string, InstructAiDoc>();
        overrides.set(MERGE_PROCESS_DOC, new MergeProcessDoc());
        overrides.set(GIT_WORKFLOW_DOC, new GitWorkflowDoc(this.mutationLog));
        const built = new Map<string, InstructAiDoc>();
        for (const name of this.templateNames()) {
            built.set(name, overrides.get(name) ?? new InstructAiDoc(name));
        }
        this.byName = built;
        return built;
    }

    /**
     * `name` plus every member reachable from it by links, breadth-first from `name`.
     *
     * A non-member is returned alone: a caller writing something that is not an instruct-ai doc (the
     * CI workflow yml) still gets exactly what it asked for.
     */
    closure(name: string, loadText: (docName: string) => string): readonly InstructAiDoc[] {
        const first = this.get(name);
        if (first === null) return [new InstructAiDoc(name)];
        const out: InstructAiDoc[] = [first];
        const seen = new Set<string>([name]);
        for (let i = 0; i < out.length; i++) {
            for (const reference of this.referencesIn(loadText(out[i].name))) {
                const doc = this.get(reference);
                if (doc === null || seen.has(reference)) continue;
                seen.add(reference);
                out.push(doc);
            }
        }
        return out;
    }
}
