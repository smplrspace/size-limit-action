import path from "path";
import os from "os";
import { promises as fs } from "fs";

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
 * Stores the raw `size-limit` output of the current run as a workflow artifact,
 * for pull request runs to read instead of building the base branch themselves.
 */
export async function uploadResults(name: string, output: string): Promise<void> {
  const directory = await createTempDirectory();
  const file = path.join(directory, RESULTS_FILE);

  await fs.writeFile(file, output, "utf8");
  await new DefaultArtifactClient().uploadArtifact(name, [file], directory);

  console.log(`Uploaded the size-limit results as the "${name}" artifact.`);
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
          !candidate.expired &&
          candidate.workflow_run &&
          candidate.workflow_run.head_branch === branch
      )
      .sort((a: any, b: any) => b.created_at.localeCompare(a.created_at));

    if (candidates.length === 0) {
      console.log(
        `No "${name}" artifact available on ${branch}, building the base branch instead.`
      );
      return null;
    }

    const [artifact] = candidates;
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

    console.log(
      `Using the "${name}" artifact from ${branch} at ${artifact.workflow_run.head_sha}, skipping the base branch build.`
    );

    return fs.readFile(path.join(directory, RESULTS_FILE), "utf8");
  } catch (error) {
    console.log(
      `Could not read the "${name}" artifact, building the base branch instead.`,
      error.message
    );
    return null;
  }
}
