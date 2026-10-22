export * from './atomic-file';
export * from './state-dir';
export * from './git-checkout';
export * from './state-dir-migration';
export * from './inform-ai-error';
export * from './claude-config-dir';
export * from './state-path-constants';

export * from './repository-layout';
export * from './typescript-require';

// The process edges (#1381): the ONLY way tooling starts git or any other program. Feature tests rebind
// them (`@webpieces/tooling-testkit`'s MockGitProcessApi / MockNativeProcessApi).
export * from './process/git-process-api';
export * from './process/native-process-api';
export * from './process/git-process-client';
export * from './process/native-process-client';
// The clock edge (#1381): production code schedules through TimerApi; a feature test runs the task itself.
export * from './process/timer-api';
export * from './process/timer-client';
// The exit edge (#1381): runMain ends the process through it, so a feature test can run a bin in process.
export * from './process/process-exit-api';
export * from './process/process-exit-client';
export * from './process/process-bindings';
