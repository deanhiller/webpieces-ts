/* eslint-disable */
/**
 * FIXTURE SUPPORT. Excluded from `tsconfig.lib.json`, so it ships in no build.
 *
 * It used to declare STUB decorators, because the extractor matched decorator names as string
 * literals and deliberately linked against nothing. Those stubs are gone: the extractor now imports
 * `@webpieces/core-util`, and the fixtures do too, so a contract in this directory is typechecked
 * against the REAL decorator signatures.
 *
 * That change is the point. The stubs had drifted — one of them declared
 * `@WpMcpTool({name, readOnly, idempotent})`, a shape the real decorator has never accepted — and
 * nothing could notice, because nothing typechecked them against anything. A fixture that cannot be
 * wrong about the thing it is a fixture FOR is not testing that thing.
 *
 * What remains here is the one thing a fixture genuinely needs of its own: a path held in a constant,
 * so the suite exercises constant FOLDING across an import.
 */
export const SAVE_PATH = '/save';
