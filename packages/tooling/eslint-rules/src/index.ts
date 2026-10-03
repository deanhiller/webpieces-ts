/** The ESLint plugin's implementation table is derived from owner entries. Activation comes from explicit policy config. */
import { LintRuleRuntime } from './rule-runtime';

export = new LintRuleRuntime().plugin();
