# Feature tests: the whole DAG, mocked edges, no real processes, no real time

Read this BEFORE you write or change any `*.spec.ts` — for a server, a `wp-*` command, a hook, or a
library. The full argument and worked examples are in
[`docs/architecture/testing-philosophy.md`](../../docs/architecture/testing-philosophy.md); this file is
the checklist. Decided on issue [#1379](https://github.com/deanhiller/webpieces-ts/issues/1379).

## The rule

**Test the program, not its classes.** Every test has the same five steps:

1. Mock only the **edges** and bind the mocks into the container: git and every child process, the
   filesystem outside a temp dir, the clock (timers, timeouts, polling, retries), executors and queues,
   and remote APIs (HTTP, GitHub, GCP, an LLM). Use `createMock<T>()` from `@webpieces/core-mock`.
2. Build the **whole real DAG**: `container.get(App)` — on a server, `createApiClient(...)`.
3. Script the mocks' answers (`mock.addValueToReturn(...)`).
4. Run it the way its user does: `app.run(args)`, the hook's JSON on stdin, the API call.
5. Assert on what **left** the program: the exit code, stdout, the requests the mocks received.

## Time and concurrency are injected, never waited for

- Production code schedules through an injected `Timer` / `Executor` (`schedule(delayMs, task)`),
  never `setTimeout` / `setInterval` directly. The mock caches the task; the test reads
  `getScheduledTasks()`, asserts the requested delay, and runs the task NOW.
- Prefer that over `vi.useFakeTimers()`, which patches globals and hides what was scheduled.
- To prove a race is handled, the mock returns promises the TEST holds, and the test resolves two
  in-flight calls in REVERSE order.

## Automatic rejects

- ❌ A spec that runs `git init`, clones, commits, pushes, or calls `execSync` / `spawn` to exercise
  logic that is not the git/process integration itself. One measured `pr-gate` spec started **4,323
  processes for 9 tests (15.5s)**; a mocked edge runs in milliseconds and does not fight every other
  agent's build for CPU.
- ❌ A test of one internal class with its collaborators mocked — the next refactor rewrites it.
- ❌ An assertion on a private field, an internal call count, or the order of internal calls.
- ❌ A sleep to let something happen.
- ❌ Changing an existing test to make a refactor pass. A refactor that forces a feature test to
  change while behaviour did not is a sign the test (or the refactor) is coupled to internals.

The one exception to "no real process": the few tests that prove an edge's OWN implementation speaks
git (or the shell) correctly. Keep them beside that implementation, and keep them few.

## When the seam does not exist yet

Much of `packages/tooling/**` still calls git and the shell directly. If the code you are testing has
no injected `GitApi` / `ProcessRunner` / `Timer`, the cure is to ADD the seam — an abstract API,
its production implementation, and a mock — not to write another process-spawning spec. Converting
the existing process-spawning specs is tracked separately from #1379.
