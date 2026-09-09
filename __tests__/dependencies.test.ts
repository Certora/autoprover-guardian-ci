import { createRequire } from "node:module";
import { describe, expect, it, vi } from "vitest";

// Most action tests replace the SDK with mocks. Exercise its real CommonJS
// entrypoint and request adapters so major SDK upgrades cannot silently break
// the Node 24 action bundle. All HTTP responses remain in-memory fixtures.
const requireSdk = createRequire(import.meta.url);
const github = requireSdk("@actions/github") as typeof import("@actions/github");
const core = requireSdk("@actions/core") as typeof import("@actions/core");

describe("Actions SDK compatibility", () => {
  it("loads the required APIs through CommonJS", () => {
    const octokit = github.getOctokit("hermetic-test-token");

    expect(core.getInput).toBeTypeOf("function");
    expect(core.setSecret).toBeTypeOf("function");
    expect(core.setFailed).toBeTypeOf("function");
    expect(octokit.paginate).toBeTypeOf("function");
    expect(octokit.graphql).toBeTypeOf("function");
    expect(octokit.rest.issues.updateComment).toBeTypeOf("function");
    expect(octokit.rest.pulls.get).toBeTypeOf("function");
  });

  it("uses the supplied fetch adapter for REST pagination", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{ id: 42, body: "Audit summary" }]), {
        headers: { "content-type": "application/json" },
      }),
    );
    const octokit = github.getOctokit("hermetic-test-token", {
      request: { fetch },
    });

    const comments = await octokit.paginate(octokit.rest.issues.listComments, {
      owner: "Certora",
      repo: "contracts",
      issue_number: 17,
      per_page: 100,
    });

    expect(comments).toEqual([{ id: 42, body: "Audit summary" }]);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe(
      "https://api.github.com/repos/Certora/contracts/issues/17/comments?per_page=100",
    );
  });

  it("supports authenticated-viewer GraphQL queries", async () => {
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          data: { comment: { id: "comment-node", viewerDidAuthor: true } },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    );
    const octokit = github.getOctokit("hermetic-test-token", {
      request: { fetch },
    });

    const result = await octokit.graphql(
      "query($id: ID!) { comment: node(id: $id) { ... on IssueComment { id viewerDidAuthor } } }",
      { id: "comment-node" },
    );

    expect(result).toEqual({
      comment: { id: "comment-node", viewerDidAuthor: true },
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch.mock.calls[0][0]).toBe("https://api.github.com/graphql");
    expect(JSON.parse(fetch.mock.calls[0][1].body).variables).toEqual({
      id: "comment-node",
    });
  });
});
