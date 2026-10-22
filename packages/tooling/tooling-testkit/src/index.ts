export { SpecTempDirs, specTempDirs } from './spec-temp-dirs';
// A checkout's on-disk layout without running git (#1381): primary clone, linked worktrees, HEAD moves.
export { CheckoutLayout } from './checkout-layout';

export { policyFixture, fixtureSchemas, fixtureTuning, fixtureMigrations, fixtureHookGuardNames } from './policy-fixture';

// Mocked process edges for feature tests (#1381): script what git and every other program answer.
export { AbortableAnswer, ProcessCallDto, ScriptedProcessTable } from './process/scripted-process-table';
export { MockScheduledTask, MockTimerApi } from './process/mock-timer-api';
export { MockProcessExitApi, MockProcessExited } from './process/mock-process-exit-api';
export type { ScriptedAnswer } from './process/scripted-process-table';
export { MockGitProcessApi } from './process/mock-git-process-api';
export { MockNativeProcessApi, ScriptedShellRun, SHELL } from './process/mock-native-process-api';
