import { getInput, setFailed } from "@actions/core";
import { context, GitHub } from "@actions/github";
// @ts-ignore
import table from "markdown-table";
import Term from "./Term";
import SizeLimit from "./SizeLimit";
import { fetchBaseResults, uploadResults } from "./Artifacts";

const SIZE_LIMIT_HEADING = `## size-limit report 📦 `;

async function fetchPreviousComment(
  octokit: GitHub,
  repo: { owner: string; repo: string },
  pr: { number: number }
) {
  // TODO: replace with octokit.issues.listComments when upgraded to v17
  const commentList = await octokit.paginate(
    "GET /repos/:owner/:repo/issues/:issue_number/comments",
    {
      ...repo,
      // eslint-disable-next-line camelcase
      issue_number: pr.number
    }
  );

  const sizeLimitComment = commentList.find(comment =>
    comment.body.startsWith(SIZE_LIMIT_HEADING)
  );
  return !sizeLimitComment ? null : sizeLimitComment;
}

async function run() {
  try {
    const { payload, repo } = context;
    const pr = payload.pull_request;

    const token = getInput("github_token");
    const skipStep = getInput("skip_step");
    const buildScript = getInput("build_script");
    const cleanScript = getInput("clean_script");
    const script = getInput("script");
    const packageManager = getInput("package_manager");
    const directory = getInput("directory") || process.cwd();
    const windowsVerbatimArguments =
      getInput("windows_verbatim_arguments") === "true" ? true : false;
    const useArtifacts = getInput("use_artifacts") === "true";
    const artifactName = getInput("artifact_name");
    const mainBranch =
      getInput("main_branch") ||
      (payload.repository && payload.repository.default_branch) ||
      "main";
    const isMainBranch = !pr && context.ref === `refs/heads/${mainBranch}`;

    if (!pr && !(useArtifacts && isMainBranch)) {
      throw new Error(
        useArtifacts
          ? `No PR found, and ${context.ref} is not the ${mainBranch} branch. Only pull_request workflows and ${mainBranch} branch runs are supported.`
          : "No PR found. Only pull_request workflows are supported."
      );
    }

    const octokit = new GitHub(token);
    const term = new Term();
    const limit = new SizeLimit();

    const { status, output } = await term.execSizeLimit(
      null,
      skipStep,
      buildScript,
      cleanScript,
      windowsVerbatimArguments,
      directory,
      script,
      packageManager
    );

    // On the main branch there is nothing to compare against and no PR to
    // comment on: the whole point of the run is to leave the results behind for
    // the pull requests that will branch off it.
    if (isMainBranch) {
      try {
        limit.parseResults(output);
      } catch (error) {
        console.log(
          "Error parsing size-limit output. The output should be a json."
        );
        throw error;
      }

      await uploadResults(artifactName, output);

      if (status > 0) {
        setFailed("Size limit has been exceeded.");
      }
      return;
    }

    let baseOutput = useArtifacts
      ? await fetchBaseResults(octokit, repo, token, artifactName, mainBranch)
      : null;

    if (baseOutput === null) {
      ({ output: baseOutput } = await term.execSizeLimit(
        pr.base.ref,
        null,
        buildScript,
        cleanScript,
        windowsVerbatimArguments,
        directory,
        script,
        packageManager
      ));
    }

    let base;
    let current;

    try {
      base = limit.parseResults(baseOutput);
      current = limit.parseResults(output);
    } catch (error) {
      console.log(
        "Error parsing size-limit output. The output should be a json."
      );
      throw error;
    }

    const body = [
      SIZE_LIMIT_HEADING,
      table(limit.formatResults(base, current))
    ].join("\r\n");

    const sizeLimitComment = await fetchPreviousComment(octokit, repo, pr);

    if (!sizeLimitComment) {
      try {
        await octokit.issues.createComment({
          ...repo,
          // eslint-disable-next-line camelcase
          issue_number: pr.number,
          body
        });
      } catch (error) {
        console.log(
          "Error creating comment. This can happen for PR's originating from a fork without write permissions."
        );
      }
    } else {
      try {
        await octokit.issues.updateComment({
          ...repo,
          // eslint-disable-next-line camelcase
          comment_id: sizeLimitComment.id,
          body
        });
      } catch (error) {
        console.log(
          "Error updating comment. This can happen for PR's originating from a fork without write permissions."
        );
      }
    }

    if (status > 0) {
      setFailed("Size limit has been exceeded.");
    }
  } catch (error) {
    setFailed(error.message);
  }
}

// Guarded so this file can be `import`-ed (e.g. from tests) without kicking off a run;
// the action itself is always invoked as the entrypoint, so behaviour is unchanged.
if (require.main === module) {
  run();
}
