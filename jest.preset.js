const nxPreset = require('@nx/jest/preset').default;

module.exports = {
    ...nxPreset,
    maxWorkers: 2,
    workerIdleMemoryLimit: '1GB',
};
