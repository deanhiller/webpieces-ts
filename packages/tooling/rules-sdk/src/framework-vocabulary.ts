/**
 * The ONE list of `framework:<value>` tag values webpieces understands — the runtime environments a
 * project can promise to run in.
 *
 * It lives in the SDK because two packages that may not depend on each other both key off it:
 * `@webpieces/code-rules` validates tag values against it, and `@webpieces/nx-webpieces-rules`
 * colors and legends every box of the architecture graph from it. Two hand-kept copies are how
 * react-native shipped with a validator entry but no graph color and no legend row (#1155).
 *
 * The three BASE runtimes are browser, node and react-native. react and angular SPECIALIZE browser,
 * express specializes node; react-native is its own runtime, not a browser (#1064).
 */
export const KNOWN_FRAMEWORKS = ['browser', 'react', 'angular', 'node', 'express', 'react-native'] as const;

export type KnownFramework = typeof KNOWN_FRAMEWORKS[number];
