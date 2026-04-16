// Re-export the shared workspace config loader so ai-hooks and the Nx
// validate-code executor use the same webpieces.config.json.
export { loadConfig, findConfigFile, CONFIG_FILENAME } from '@webpieces/config';
