/**
 * Jest setup file to suppress verbose console output.
 *
 * By default, Jest wraps console methods and shows stack traces
 * for every console.log/error/warn call, which creates multi-line
 * output like:
 *
 *   console.log
 *     My log message
 *
 *       at Object.<anonymous> (file.ts:123:45)
 *
 * This setup replaces Jest's console with Node's native console,
 * which only shows:
 *
 *   My log message
 */

// Save Jest's console for restoration if needed
const jestConsole = console;

// Replace with Node's native console (no stack traces)
global.console = require('console');
