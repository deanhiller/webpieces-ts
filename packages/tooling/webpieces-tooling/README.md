# @webpieces/webpieces-tooling

Install the complete toolchain through this umbrella package. Its workspace dependencies carry every published tooling package and its public bins, including `wp-ai-rules-hook` and `wp-ai-guards-hook`.

For a published release, declare `@webpieces/webpieces-tooling` as the single tooling dependency. Existing consumers should replace their former Nx umbrella declaration with this package when adopting the release. Keep registering `@webpieces/nx-webpieces-rules` in `nx.json`; that package implements the inference plugin and executors.

OpenClaw uses `@webpieces/webpieces-tooling/openclaw-plugin` and the packaged `openclaw.plugin.json`. Its single write/edit handler composes source rules, workflow guards, and source extensions in their original order.

This package owns packaging and composition smoke checks. Feature suites remain in ai-hook-rules, agent-workflow-rules, pr-gate, and the Nx implementation package.

The repository itself is validated with its previously published catalog release. Adding this source package does not upgrade that installed toolchain or its committed dispatcher.

The ordinary test target runs the small aggregation and OpenClaw checks. Run `pnpm nx run webpieces-tooling:release-test` when changing `scripts/publish-packages.sh`; it exercises the release retry loop in a fake registry workspace and is kept separate from source-rule edit workloads.

## Repo-local rules

A repository can add rules of its own beside webpieces' built-in ones. A local rule is one TypeScript
class. webpieces runs it in BOTH places, with no setting choosing between them: the Write/Edit source
guard refuses the edit as it is written, and `wp-build` / the PR gate (`validate-code`) checks the
committed diff. A repository that does not want the write-time check turns the source guard off with its
existing switches. The two runners parse the same whole-file text with the same `SourceSyntax`, so they
report the same sites at the same lines.

A rule decides from the file's **syntax** only. The guard sees one proposed file and no compiler program,
so a rule that needs type information cannot give the same verdict in both places.

**1. Write the rule.** Import everything from `@webpieces/webpieces-tooling/local-rules`, including `ts`.
Walk the parse with that `ts`, never a `typescript` of your own, because node kinds differ between
TypeScript releases.

```ts
// webpieces-rules/no-banned-console.ts
import { ConfigObject, FieldDef, LocalRule, LocalRuleConfig, LocalRuleFile, LocalRuleFinding, Option, ts }
    from '@webpieces/webpieces-tooling/local-rules';

export class NoBannedConsoleConfig extends LocalRuleConfig {
    methods!: string[];
}

export class NoBannedConsoleRule extends LocalRule<NoBannedConsoleConfig> {
    readonly id = 'no-banned-console';
    readonly description = 'Production code must not call the banned console methods.';
    readonly files = ['**/*.ts'];
    readonly cures = [new Option('Throw a structured error, or log through the repo logger.', true)];
    readonly settings = { methods: FieldDef.nonEmptyStrings() };
    readonly seed = Object.assign(new ConfigObject(), { mode: 'NEW_AND_MODIFIED_CODE', methods: ['log'] });

    check(file: LocalRuleFile, config: NoBannedConsoleConfig): readonly LocalRuleFinding[] {
        const findings: LocalRuleFinding[] = [];
        const visit = (node: ts.Node): void => {
            if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
                && node.expression.expression.getText() === 'console'
                && config.methods.includes(node.expression.name.text)) {
                findings.push(new LocalRuleFinding(file.lineOf(node), file.endLineOf(node),
                    `console.${node.expression.name.text}() is banned here.`));
            }
            ts.forEachChild(node, visit);
        };
        visit(file.source);
        return findings;
    }
}
```

**2. Make it a pack.** One module declares the pack and implements both runners:

```ts
// webpieces-rules/local-rules.ts
import { LocalRulePack } from '@webpieces/webpieces-tooling/local-rules';
import { NoBannedConsoleRule } from './no-banned-console';

const pack = new LocalRulePack('local-rules', __filename, [new NoBannedConsoleRule()]);
export const rulePackManifest = pack.rulePackManifest;
export const sourceRuleRuntime = pack.sourceRuleRuntime;
export const buildRuleRuntime = pack.buildRuleRuntime;
export const buildDebugRuntime = pack.buildDebugRuntime;
```

The fourth export is the one-rule debug run (below); without it `wp-validate-code --rule=<id>` refuses
the pack's rules.

**3. Register it** in `webpieces.config.json`, beside the packs you already declare, with its own owner file:

```json
{ "package": "./webpieces-rules/local-rules.ts", "config": ".webpieces-config/rules/local.json" }
```

Two things trip the first registration (both measured dogfooding this in webpieces-ts, #1320):

- The pack lives outside every nx project, so a repo running `validate-ts-in-src` refuses to create it
  until its folder is listed in that rule's `excludePaths` (e.g. `"webpieces-rules/**"`).
- A declared owner file must be tracked by git. The PR gate and CI (`wp-ci`) refuse an untracked or
  ignored one — the guard hooks do not check it, since it is a commit-time invariant (#1355). Create the
  owner file, then stage it: `git add -- <owner file>`, or `pnpm wp-migrate-dirs --stage`, which stages
  the declaration and every owner file without reformatting the ones it does not change.

The `.ts` module is transpiled in memory when it loads, so there is no build step. The next tool call
refuses the missing owner entry and prints the rule's seed to paste:

```json
{
    "no-banned-console": {
        "mode": "NEW_AND_MODIFIED_CODE",
        "methods": ["log"],
        "turnOffRuleUntilEpoch": 0,
        "turnOffRuleWhileOnBranch": null
    }
}
```

Nothing has a default. You must state `mode` and every setting the rule declares. `mode` takes the values
the built-in diff rules take: `OFF`, `NEW_AND_MODIFIED_CODE` (only findings on changed lines),
`NEW_AND_MODIFIED_FILES`, `MODIFIED_PROJECTS` and `RUN_EVERY_TIME`. The framework applies the rest in both
runners: `turnOffRuleUntilEpoch`, `turnOffRuleWhileOnBranch`, the optional `excludePaths` and `reason`, and
the per-site escape `// webpieces-disable no-banned-console -- <reason of at least 20 characters>` on the
reported line or the line above it. A disable with no reason does not exempt the site. Rule ids must be
kebab-case and must not collide with any other pack's.

**Count what is left with the debug run** (#1330), exactly as for a built-in code rule and with no config
edit:

```bash
pnpm exec wp-validate-code --rule=no-banned-console --mode=RUN_EVERY_TIME
pnpm exec wp-validate-code --rule=no-banned-console --mode=RUN_EVERY_TIME --projects=my-app,my-lib
```

It runs only that rule, through the same build policy the gate runs, so per-site disables, the repo's
`excludePaths` and the rule's own apply unchanged. It ignores the two escape hatches for that run, prints
the rule's own report and then one site count per project, writes nothing, and exits non-zero while any
site remains. `RUN_EVERY_TIME` judges every file in the repo and never consults the diff. An unknown
`--rule` is refused with the list of rules that accept a debug run, local ones included.
