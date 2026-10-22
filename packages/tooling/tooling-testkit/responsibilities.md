# tooling-testkit

Own shared development fixtures, including scratch directory creation and cleanup and the mocked process edges. Consumers declare this package through devDependencies.

The mocked process edges (#1381) are `MockGitProcessApi` and `MockNativeProcessApi`, which a feature test rebinds in place of `@webpieces/tooling-common`'s git and program clients: answers scripted by argv, every call recorded, an unscripted call throws naming the argv.

This package is excluded from the production toolchain bundle. The drawOnGraph:false tag hides it from rendered production graphs while retaining graph data.
