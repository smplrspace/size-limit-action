// @ts-nocheck

module.exports = {
  clearMocks: true,
  moduleFileExtensions: ["js", "ts"],
  // The real @actions/artifact pulls in undici -> @fastify/busboy, whose `node:`-prefixed
  // imports this repo's 2020-era jest-resolve cannot resolve. Tests substitute a manual
  // mock instead; see src/__mocks__/actions-artifact.ts.
  moduleNameMapper: {
    "^@actions/artifact$": "<rootDir>/src/__mocks__/actions-artifact.ts",
    // Real git access isn't needed in tests, and it keeps `exec` easy to drive per test.
    "^@actions/exec$": "<rootDir>/src/__mocks__/actions-exec.ts"
  },
  testEnvironment: "node",
  testMatch: ["**/*.spec.ts"],
  testRunner: "jest-circus/runner",
  transform: {
    "^.+\\.ts$": "ts-jest"
  },
  verbose: true
};
