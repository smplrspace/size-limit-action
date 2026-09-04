import os from "os";
import path from "path";
import { promises as fs } from "fs";

// The `use_artifacts` cold-start path (no artifact yet, or the read fails for any
// reason) must fall back to a base-branch build rather than fail the run. This file
// exercises that fallback directly, since it is not exercised by a real Actions runner.

import { DefaultArtifactClient } from "@actions/artifact"; // resolves to the manual mock
import { fetchBaseResults } from "./Artifacts";

// The manual mock (src/__mocks__/actions-artifact.ts) exports a jest.fn() under this
// name; cast it back so tests can drive its implementation and assertions.
const MockArtifactClient = (DefaultArtifactClient as unknown) as jest.Mock;

const repo = { owner: "smplrspace", repo: "size-limit-action" };
const token = "fake-token";
const artifactName = "size-limit-results";
const mainBranch = "main";

function fakeOctokit(request: jest.Mock) {
  return ({ request } as unknown) as any;
}

afterEach(() => {
  jest.clearAllMocks();
});

test("falls back to null when no artifact exists yet on the main branch (cold start)", async () => {
  const request = jest.fn().mockResolvedValue({ data: { artifacts: [] } });

  const result = await fetchBaseResults(
    fakeOctokit(request),
    repo,
    token,
    artifactName,
    mainBranch
  );

  expect(result).toBeNull();
  expect(MockArtifactClient).not.toHaveBeenCalled();
});

test("falls back to null when listing artifacts fails", async () => {
  const request = jest.fn().mockRejectedValue(new Error("API rate limited"));

  const result = await fetchBaseResults(
    fakeOctokit(request),
    repo,
    token,
    artifactName,
    mainBranch
  );

  expect(result).toBeNull();
});

test("falls back to null when the only matching artifact has expired", async () => {
  const request = jest.fn().mockResolvedValue({
    data: {
      artifacts: [
        {
          id: 1,
          expired: true,
          created_at: "2020-01-01T00:00:00Z",
          workflow_run: { id: 10, head_branch: mainBranch, head_sha: "abc" }
        }
      ]
    }
  });

  const result = await fetchBaseResults(
    fakeOctokit(request),
    repo,
    token,
    artifactName,
    mainBranch
  );

  expect(result).toBeNull();
});

test("falls back to null when the download itself fails", async () => {
  const request = jest.fn().mockResolvedValue({
    data: {
      artifacts: [
        {
          id: 1,
          expired: false,
          created_at: "2024-01-01T00:00:00Z",
          workflow_run: { id: 10, head_branch: mainBranch, head_sha: "abc" }
        }
      ]
    }
  });
  MockArtifactClient.mockImplementation(() => ({
    downloadArtifact: jest.fn().mockRejectedValue(new Error("network error"))
  }));

  const result = await fetchBaseResults(
    fakeOctokit(request),
    repo,
    token,
    artifactName,
    mainBranch
  );

  expect(result).toBeNull();
});

test("reads back the results file when a matching artifact is found", async () => {
  const request = jest.fn().mockResolvedValue({
    data: {
      artifacts: [
        {
          id: 1,
          expired: false,
          created_at: "2024-01-01T00:00:00Z",
          workflow_run: { id: 10, head_branch: mainBranch, head_sha: "abc" }
        }
      ]
    }
  });
  const results = JSON.stringify([{ name: "dist/index.js", size: "123" }]);
  MockArtifactClient.mockImplementation(() => ({
    downloadArtifact: jest.fn().mockImplementation(async (_id, options) => {
      await fs.writeFile(
        path.join(options.path, "size-limit-results.json"),
        results,
        "utf8"
      );
    })
  }));

  const result = await fetchBaseResults(
    fakeOctokit(request),
    repo,
    token,
    artifactName,
    mainBranch
  );

  expect(result).toBe(results);
});

test("only considers artifacts produced on the requested branch", async () => {
  const request = jest.fn().mockResolvedValue({
    data: {
      artifacts: [
        {
          id: 1,
          expired: false,
          created_at: "2024-01-01T00:00:00Z",
          workflow_run: { id: 10, head_branch: "some-other-branch", head_sha: "abc" }
        }
      ]
    }
  });

  const result = await fetchBaseResults(
    fakeOctokit(request),
    repo,
    token,
    artifactName,
    mainBranch
  );

  expect(result).toBeNull();
  expect(MockArtifactClient).not.toHaveBeenCalled();
});

test("creates its scratch directories outside the checkout", async () => {
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "size-limit-runner-temp-"));
  process.env.RUNNER_TEMP = tmp;

  const request = jest.fn().mockResolvedValue({
    data: {
      artifacts: [
        {
          id: 1,
          expired: false,
          created_at: "2024-01-01T00:00:00Z",
          workflow_run: { id: 10, head_branch: mainBranch, head_sha: "abc" }
        }
      ]
    }
  });
  let usedDirectory = "";
  MockArtifactClient.mockImplementation(() => ({
    downloadArtifact: jest.fn().mockImplementation(async (_id, options) => {
      usedDirectory = options.path;
      await fs.writeFile(
        path.join(options.path, "size-limit-results.json"),
        "[]",
        "utf8"
      );
    })
  }));

  await fetchBaseResults(fakeOctokit(request), repo, token, artifactName, mainBranch);

  expect(usedDirectory.startsWith(tmp)).toBe(true);

  process.env.RUNNER_TEMP = previousRunnerTemp;
});
