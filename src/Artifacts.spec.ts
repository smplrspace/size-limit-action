import os from "os";
import path from "path";
import { promises as fs } from "fs";

// The `use_artifacts` cold-start path (no artifact yet, or the read fails for any
// reason) must fall back to a base-branch build rather than fail the run. This file
// exercises that fallback directly, since it is not exercised by a real Actions runner.

import { DefaultArtifactClient } from "@actions/artifact"; // resolves to the manual mock
import { exec } from "@actions/exec"; // resolves to the manual mock
import {
  changedSincePullRequest,
  fetchBaseResults,
  findMergedPullRequest,
  reusePullRequestResult
} from "./Artifacts";

// The manual mocks (src/__mocks__/actions-artifact.ts, src/__mocks__/actions-exec.ts)
// export jest.fn()s under these names; cast them back so tests can drive their
// implementation and assertions.
const MockArtifactClient = (DefaultArtifactClient as unknown) as jest.Mock;
const mockExec = (exec as unknown) as jest.Mock;

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

  // Not `process.env.RUNNER_TEMP = previousRunnerTemp`: when it was unset to begin with,
  // that coerces to the literal string "undefined" (env vars are always strings) and
  // breaks createTempDirectory's `|| os.tmpdir()` fallback for every test running after
  // this one in the same process.
  if (previousRunnerTemp === undefined) {
    delete process.env.RUNNER_TEMP;
  } else {
    process.env.RUNNER_TEMP = previousRunnerTemp;
  }
});

// -- findMergedPullRequest ---------------------------------------------------------
// Reusing a merged pull request's own result instead of rebuilding on the main branch
// starts with finding which pull request (if any) produced a given commit.

const sha = "merge-commit-sha";

describe("findMergedPullRequest", () => {
  test("returns null when the commit was not produced by a pull request merge (a direct push)", async () => {
    const request = jest.fn().mockResolvedValue({ data: [] });

    const result = await findMergedPullRequest(fakeOctokit(request), repo, sha);

    expect(result).toBeNull();
  });

  test("returns null when the lookup fails", async () => {
    const request = jest.fn().mockRejectedValue(new Error("API rate limited"));

    const result = await findMergedPullRequest(fakeOctokit(request), repo, sha);

    expect(result).toBeNull();
  });

  test("ignores a pull request whose merge_commit_sha doesn't match, or that isn't actually merged", async () => {
    const request = jest.fn().mockResolvedValue({
      data: [
        { number: 1, merged_at: null, merge_commit_sha: sha, head: { sha: "head-1" } },
        {
          number: 2,
          merged_at: "2024-01-01T00:00:00Z",
          merge_commit_sha: "some-other-sha",
          head: { sha: "head-2" }
        }
      ]
    });

    const result = await findMergedPullRequest(fakeOctokit(request), repo, sha);

    expect(result).toBeNull();
  });

  test("returns the merged pull request's number and head sha", async () => {
    const request = jest.fn().mockResolvedValue({
      data: [
        {
          number: 42,
          merged_at: "2024-01-01T00:00:00Z",
          merge_commit_sha: sha,
          head: { sha: "pr-head-sha" }
        }
      ]
    });

    const result = await findMergedPullRequest(fakeOctokit(request), repo, sha);

    expect(result).toEqual({ number: 42, headSha: "pr-head-sha" });
  });
});

// -- changedSincePullRequest --------------------------------------------------------

describe("changedSincePullRequest", () => {
  test("treats it as changed when the pull request's head commit can't be fetched", async () => {
    mockExec.mockRejectedValueOnce(new Error("couldn't find remote ref"));

    const result = await changedSincePullRequest("pr-head-sha", sha, "frontend/");

    expect(result).toBe(true);
  });

  test("is false when the directory is identical between the two commits", async () => {
    mockExec.mockResolvedValueOnce(0); // git fetch
    mockExec.mockResolvedValueOnce(0); // git diff --quiet: no differences

    const result = await changedSincePullRequest("pr-head-sha", sha, "frontend/");

    expect(result).toBe(false);
  });

  test("is true when the directory differs between the two commits", async () => {
    mockExec.mockResolvedValueOnce(0); // git fetch
    mockExec.mockResolvedValueOnce(1); // git diff --quiet: differences found

    const result = await changedSincePullRequest("pr-head-sha", sha, "frontend/");

    expect(result).toBe(true);
  });

  test("diffs the pull request's head commit against the given commit, scoped to the directory", async () => {
    mockExec.mockResolvedValueOnce(0);
    mockExec.mockResolvedValueOnce(0);

    await changedSincePullRequest("pr-head-sha", sha, "frontend/");

    expect(mockExec).toHaveBeenLastCalledWith(
      "git",
      ["diff", "--quiet", "pr-head-sha", sha, "--", "frontend/"],
      expect.objectContaining({ ignoreReturnCode: true })
    );
  });
});

// -- reusePullRequestResult ----------------------------------------------------------
// The end-to-end fallback chain: any failure at any step must fall back to a real build,
// never fail the run outright.

function mockNoDiff() {
  mockExec.mockResolvedValueOnce(0); // git fetch
  mockExec.mockResolvedValueOnce(0); // git diff --quiet: no differences
}

describe("reusePullRequestResult", () => {
  test("returns null when the commit wasn't produced by a merged pull request", async () => {
    const request = jest.fn().mockResolvedValue({ data: [] });

    const result = await reusePullRequestResult(
      fakeOctokit(request),
      repo,
      token,
      artifactName,
      sha,
      "frontend/"
    );

    expect(result).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });

  test("returns null when the directory changed on the main branch since the pull request's build", async () => {
    const request = jest.fn().mockResolvedValue({
      data: [
        {
          number: 42,
          merged_at: "2024-01-01T00:00:00Z",
          merge_commit_sha: sha,
          head: { sha: "pr-head-sha" }
        }
      ]
    });
    mockExec.mockResolvedValueOnce(0); // git fetch
    mockExec.mockResolvedValueOnce(1); // git diff --quiet: differences found

    const result = await reusePullRequestResult(
      fakeOctokit(request),
      repo,
      token,
      artifactName,
      sha,
      "frontend/"
    );

    expect(result).toBeNull();
    expect(MockArtifactClient).not.toHaveBeenCalled();
  });

  test("returns null when the pull request never uploaded its own result", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            merged_at: "2024-01-01T00:00:00Z",
            merge_commit_sha: sha,
            head: { sha: "pr-head-sha" }
          }
        ]
      })
      .mockResolvedValueOnce({ data: { artifacts: [] } });
    mockNoDiff();

    const result = await reusePullRequestResult(
      fakeOctokit(request),
      repo,
      token,
      artifactName,
      sha,
      "frontend/"
    );

    expect(result).toBeNull();
  });

  test("returns null when the reused artifact is corrupt", async () => {
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            merged_at: "2024-01-01T00:00:00Z",
            merge_commit_sha: sha,
            head: { sha: "pr-head-sha" }
          }
        ]
      })
      .mockResolvedValueOnce({
        data: {
          artifacts: [
            {
              id: 1,
              expired: false,
              created_at: "2024-01-01T00:00:00Z",
              workflow_run: { id: 10, head_sha: "pr-head-sha" }
            }
          ]
        }
      });
    mockNoDiff();
    MockArtifactClient.mockImplementation(() => ({
      downloadArtifact: jest.fn().mockImplementation(async (_id, options) => {
        await fs.writeFile(
          path.join(options.path, "size-limit-results.json"),
          "not valid json",
          "utf8"
        );
      })
    }));

    const result = await reusePullRequestResult(
      fakeOctokit(request),
      repo,
      token,
      artifactName,
      sha,
      "frontend/"
    );

    expect(result).toBeNull();
  });

  test("reuses the merged pull request's own result when everything lines up", async () => {
    const results = JSON.stringify([{ name: "dist/index.js", size: "123" }]);
    const request = jest
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            number: 42,
            merged_at: "2024-01-01T00:00:00Z",
            merge_commit_sha: sha,
            head: { sha: "pr-head-sha" }
          }
        ]
      })
      .mockResolvedValueOnce({
        data: {
          artifacts: [
            // Not this one: same name, but from an unrelated branch's run.
            {
              id: 1,
              expired: false,
              created_at: "2024-02-01T00:00:00Z",
              workflow_run: { id: 11, head_branch: "main", head_sha: "some-other-sha" }
            },
            {
              id: 2,
              expired: false,
              created_at: "2024-01-01T00:00:00Z",
              workflow_run: { id: 10, head_branch: "feature/x", head_sha: "pr-head-sha" }
            }
          ]
        }
      });
    mockNoDiff();
    MockArtifactClient.mockImplementation(() => ({
      downloadArtifact: jest.fn().mockImplementation(async (_id, options) => {
        await fs.writeFile(
          path.join(options.path, "size-limit-results.json"),
          results,
          "utf8"
        );
      })
    }));

    const result = await reusePullRequestResult(
      fakeOctokit(request),
      repo,
      token,
      artifactName,
      sha,
      "frontend/"
    );

    expect(result).toBe(results);
  });
});
