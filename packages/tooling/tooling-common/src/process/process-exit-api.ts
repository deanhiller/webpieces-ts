/**
 * THE edge where a command-line program ends its own process (#1381). Exactly one caller: `runMain`, the
 * single sanctioned exit site of every `wp-*` bin. Making the exit an edge is what lets a feature test run
 * a bin's whole top-level path IN PROCESS — the test passes `MockProcessExitApi` (from
 * `@webpieces/tooling-testkit`), which records the code and stops the run, instead of starting a node
 * child just to read its exit status.
 */
export abstract class ProcessExitApi {
    /** End this process with `code`. Never returns. */
    abstract exit(code: number): never;
}
