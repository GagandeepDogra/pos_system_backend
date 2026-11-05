/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/test'],
  testMatch: ['**/*.spec.ts'],
  transform: { '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }] },
  moduleNameMapper: { '^@dhaba/shared$': '<rootDir>/../../packages/shared/src' },
  collectCoverageFrom: ['src/**/*.ts', '!src/main.ts'],
  coverageReporters: ['text-summary', 'lcov'],
  // REQ-136: storage and billing must stay at or above 80% coverage.
  coverageThreshold: {
    './src/storage/': { statements: 80, branches: 80, functions: 80, lines: 80 },
    './src/billing/': { statements: 80, branches: 80, functions: 80, lines: 80 },
  },
};
