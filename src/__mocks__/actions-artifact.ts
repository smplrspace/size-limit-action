// Manual mock for @actions/artifact, wired in via jest.config.js's moduleNameMapper.
// The real package pulls in undici -> @fastify/busboy, which uses `node:`-prefixed
// imports that this repo's 2020-era jest/jest-resolve cannot resolve. Tests never need
// the real network/SDK behaviour, only a substitutable DefaultArtifactClient.
export const DefaultArtifactClient = jest.fn();
