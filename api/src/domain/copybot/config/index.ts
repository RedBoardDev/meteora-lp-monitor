/**
 * Copy-bot · runtime config — public surface. Import from `@/domain/copybot/config`.
 */
export * from './types';
export { CONFIG_DEFAULTS, DEFAULT_LEADER_ADDRESS, USER_DEFAULTS } from './defaults';
export { CopybotConfigSchema, isValidConfigBlob, parseConfig } from './schema';
export { effectiveFor, withEnvOverride } from './effective';
export { addLeader, coerceValue, getAtPath, MAX_LEADERS, removeLeader, setAtPath } from './edit';
