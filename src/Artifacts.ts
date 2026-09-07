import path from "path";
import os from "os";
import { promises as fs } from "fs";
import { exec } from "@actions/exec";

import { GitHub } from "@actions/github";
import { DefaultArtifactClient } from "@actions/artifact";

// Kept out of main.ts so this module never pulls in @actions/core: @actions/artifact
// forces @actions/core to a version whose OIDC support drags in undici, which this
// repo's 2020-era jest cannot resolve (`node:`-prefixed imports). Importing only
// @actions/github here keeps this module test-friendly; see Artifacts.spec.ts.

export const RESULTS_FILE = "size-limit-results.json";

/**
 * Creates a scratch directory outside the checkout, so that writing or reading
 * the results file never interferes with the `git checkout` of the base branch.
 */
async function createTempDirectory(): Promise<string> {
  const parent = process.env.RUNNER_TEMP || os.tmpdir();
  return fs.mkdtemp(path.join(parent, "size-limit-action-"));
}

/**
 * Stores the raw `size-limit` output of the current run as a workflow artifact. Used
 * both for the main-branch result future pull requests compare against, and for a pull
 * request's own result, which a later merge of that same pull request can reuse instead
 * of rebuilding.
 */
export async function uploadResults(name: string, output: string): Promise<void> {
  const directory = await createTempDirectory();
  const file = path.join(directory, RESULTS_FILE);

  await fs.writeFile(file, output, "utf8");
  await new DefaultArtifactClient().uploadArtifact(name, [file], directory);

  console.log(`Uploaded the size-limit results as the "${name}" artifact.`);
}

/**
 * Finds the most recent non-expired artifact called `name` whose run matches `matches`.
 */
async function findArtifact(
  octokit: GitHub,
  repo: { owner: string; repo: string },
  name: string,
  matches: (candidate: any) => boolean
): Promise<any | null> {
  const { data } = await octokit.request(
    "GET /repos/:owner/:repo/actions/artifacts",
    {
      ...repo,
      name,
      // eslint-disable-next-line camelcase
      per_page: 100
    }
  );

  const candidates = data.artifacts
    .filter(
      (candidate: any) =>
        !candidate.expired && candidate.workflow_run && matches(candidate)
    )
    .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));

  return candidates.length === 0 ? null : candidates[0];
}

async function downloadArtifact(
  artifact: any,
  token: string,
  repo: { owner: string; repo: string }
): Promise<string> {
  const directory = await createTempDirectory();

  await new DefaultArtifactClient().downloadArtifact(artifact.id, {
    path: directory,
    findBy: {
      token,
      workflowRunId: artifact.workflow_run.id,
      repositoryOwner: repo.owner,
      repositoryName: repo.repo
    }
  });

  return fs.readFile(path.join(directory, RESULTS_FILE), "utf8");
}

/**
 * Reads back the most recent results artifact produced on the main branch.
 * Returns null whenever it cannot be used, so that the caller falls back to
 * building the base branch: there is nothing on the main branch yet, the
 * artifact has expired (they are kept for 90 days at most, often far less),
 * or the token is not allowed to read it.
 */
export async function fetchBaseResults(
  octokit: GitHub,
  repo: { owner: string; repo: string },
  token: string,
  name: string,
  branch: string
): Promise<string | null> {
  try {
    const artifact = await findArtifact(
      octokit,
      repo,
      name,
      candidate => candidate.workflow_run.head_branch === branch
    );

    if (!artifact) {
      console.log(
        `No "${name}" artifact available on ${branch}, building the base branch instead.`
      );
      return null;
    }

    const content = await downloadArtifact(artifact, token, repo);

    console.log(
      `Using the "${name}" artifact from ${branch} at ${artifact.workflow_run.head_sha}, skipping the base branch build.`
    );

    return content;
  } catch (error) {
    console.log(
      `Could not read the "${name}" artifact, building the base branch instead.`,
      error.message
    );
    return null;
  }
}

/**
 * Finds the pull request whose merge produced `sha`, if any - a direct push to the main
 * branch (not through a pull request) has none.
 */
export async function findMergedPullRequest(
  octokit: GitHub,
  repo: { owner: string; repo: string },
  sha: string
): Promise<{ number: number; headSha: string } | null> {
  try {
    const { data } = await octokit.request(
      "GET /repos/:owner/:repo/commits/:ref/pulls",
      { ...repo, ref: sha }
    );

    const pr = data.find(
      (candidate: any) =>
        candidate.merged_at && candidate.merge_commit_sha === sha
    );

    if (!pr) {
      console.log(
        `${sha} is not the merge of a pull request (a direct push, or a merge strategy that doesn't produce this exact sha), building instead of reusing.`
      );
      return null;
    }

    return { number: pr.number, headSha: pr.head.sha };
  } catch (error) {
    console.log(
      "Could not look up the pull request behind this commit.",
      error.message
    );
    return null;
  }
}

/**
 * True when `directory` differs between a pull request's own head commit and the
 * resulting merge commit - i.e. something else landed on the main branch in between that
 * touched the same build, so the pull request's own result can no longer be trusted.
 * Relies on GitHub allowing a shallow fetch by exact commit SHA, which it does for
 * github.com-hosted repositories.
 */
export async function changedSincePullRequest(
  headSha: string,
  sha: string,
  directory: string
): Promise<boolean> {
  try {
    await exec(`git fetch origin ${headSha} --depth=1`);
  } catch (error) {
    console.log(
      "Could not fetch the pull request's head commit, treating it as changed.",
      error.message
    );
    return true;
  }

  const status = await exec(
    "git",
    ["diff", "--quiet", headSha, sha, "--", directory],
    { ignoreReturnCode: true }
  );

  return status !== 0;
}

/**
 * Reuses the size-limit result the pull request behind `sha` already computed for its own
 * head commit, when that result is still valid for the resulting main-branch tree. Returns
 * null whenever it cannot be reused, so the caller falls back to a real build: `sha` was
 * not produced by a pull request merge, that pull request never uploaded a result (for
 * example it predates `use_artifacts`, or didn't touch `directory`), `directory` changed on
 * the main branch since that pull request's own build, or the artifact has expired.
 */
export async function reusePullRequestResult(
  octokit: GitHub,
  repo: { owner: string; repo: string },
  token: string,
  name: string,
  sha: string,
  directory: string
): Promise<string | null> {
  const pr = await findMergedPullRequest(octokit, repo, sha);

  if (!pr) {
    return null;
  }

  if (await changedSincePullRequest(pr.headSha, sha, directory)) {
    console.log(
      `#${pr.number}'s own build is stale: ${directory} changed on the main branch since. Building instead of reusing.`
    );
    return null;
  }

  try {
    const artifact = await findArtifact(
      octokit,
      repo,
      name,
      candidate => candidate.workflow_run.head_sha === pr.headSha
    );

    if (!artifact) {
      console.log(
        `No "${name}" artifact found for #${pr.number}'s own build, building instead.`
      );
      return null;
    }

    const content = await downloadArtifact(artifact, token, repo);
    // Validate before trusting it as a substitute for a real build.
    JSON.parse(content);

    console.log(
      `Reusing #${pr.number}'s own size-limit result instead of rebuilding.`
    );

    return content;
  } catch (error) {
    console.log(
      `Could not reuse #${pr.number}'s result, building instead.`,
      error.message
    );
    return null;
  }
}
