import { NoCustomCssConfig } from './rule-configs';
import { matchesAnyGlob } from './exclude-paths';

/**
 * Test sources are never Angular UI, so no engine has ever enforced `no-custom-css` on them. The list
 * lived TWICE — once in the hook rule, once in the CI validator — which is the same duplication that
 * let `allowGlobs` diverge. One copy, here, beside the exemption it belongs to.
 */
const TEST_PATHS: readonly RegExp[] = [/\.test\.ts$/, /\.spec\.ts$/, /__tests__\//];

/**
 * THE `no-custom-css` path exemption, shared by both engines that enforce the rule: the edit-time hook
 * (`@webpieces/ai-hook-rules`, per file) and the CI validator (`@webpieces/code-rules`, over the changed
 * file set).
 *
 * ## Why it lives in rules-config rather than in either engine
 *
 * `allowGlobs` is declared on {@link NoCustomCssConfig} and injected into BOTH engines. It used to be
 * honoured by the hook alone: the CI validator never read the field, so a consumer who exempted
 * `**\/design.html` watched the editor go quiet and CI keep failing on the very files it had exempted,
 * with no diagnostic anywhere. The cure is not "read the field in the validator too" — that is a second
 * implementation of one predicate, which is exactly the shape that produced the divergence. It is ONE
 * class, in the one package both engines already depend on for the schema.
 *
 * ## Constructed from the config, never from a loose list
 *
 * The constructor takes the whole {@link NoCustomCssConfig}, so a scope cannot be built that has quietly
 * dropped `allowGlobs` on the way in. TypeScript still cannot force a call site to CONSULT the scope —
 * that is the gap the two remaining engines close by having exactly one place each where the file set is
 * narrowed.
 *
 * Glob semantics are `matchesAnyGlob`: minimatch against the workspace-relative path, plus the
 * directory-prefix form (`libraries/vendor` also exempts `libraries/vendor/**`). An empty `allowGlobs`
 * matches nothing, so an unconfigured rule is enforced everywhere except the test paths above.
 */
export class NoCustomCssScope {
    private readonly allowGlobs: readonly string[];

    constructor(config: NoCustomCssConfig) {
        this.allowGlobs = config.allowGlobs ?? [];
    }

    /** True when `no-custom-css` must not look at this path at all — a test source, or a configured `allowGlobs` match. */
    isExempt(relPath: string): boolean {
        const norm = relPath.replace(/\\/g, '/');
        if (TEST_PATHS.some((re: RegExp) => re.test(norm))) return true;
        return matchesAnyGlob(norm, this.allowGlobs);
    }
}
