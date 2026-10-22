# tooling-testkit

Own shared development fixtures, including scratch directory creation and cleanup and the mocked process edges. Consumers declare this package through devDependencies.

The mocked process edges (#1381) are `MockGitProcessApi` and `MockNativeProcessApi`, which a feature test rebinds in place of `@webpieces/tooling-common`'s git and program clients: answers scripted by argv, every call recorded, an unscripted call throws naming the argv. An answer may be a promise the test holds (a hung command, or two calls resolved out of order); when the program's deadline aborts such a call it reports PROCESS_KILLED, as the real client does.

`MockTimerApi` caches every scheduled task (`getScheduledTasks()`, each with its `delayMs`) and runs none until the test calls `run()`; `now()` returns what the test set. `MockProcessExitApi` records the exit code `runMain` asked for and stops the run there. `CheckoutLayout` writes a checkout's `.git` layout (primary clone, linked worktrees, a HEAD move) without running git.

This package is excluded from the production toolchain bundle. The drawOnGraph:false tag hides it from rendered production graphs while retaining graph data.
