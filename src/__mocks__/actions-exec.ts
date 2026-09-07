// Manual mock for @actions/exec, wired in via jest.config.js's moduleNameMapper. Tests
// never need to actually invoke git; they drive `exec`'s return value/implementation
// directly, same pattern as src/__mocks__/actions-artifact.ts.
export const exec = jest.fn();
