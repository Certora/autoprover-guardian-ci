import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createCommentMock,
  getCommitMock,
  getOctokitMock,
  infoMock,
  listCommentsMock,
  paginateMock,
  searchIssuesMock,
  updateCommentMock,
} = vi.hoisted(() => ({
  createCommentMock: vi.fn(),
  getCommitMock: vi.fn(),
  getOctokitMock: vi.fn(),
  infoMock: vi.fn(),
  listCommentsMock: vi.fn(),
  paginateMock: vi.fn(),
  searchIssuesMock: vi.fn(),
  updateCommentMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  info: infoMock,
  warning: vi.fn(),
}));

vi.mock("@actions/github", () => ({
  context: {
    repo: {
      owner: "Certora",
      repo: "contracts",
    },
  },
  getOctokit: getOctokitMock,
}));

import { GitHubClient } from "../src/github";

const HEAD_SHA = "b".repeat(40);
const RUN_ID = "11111111-1111-4111-8111-111111111111";

describe("GitHubClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOctokitMock.mockReturnValue({
      paginate: paginateMock,
      rest: {
        repos: {
          getCommit: getCommitMock,
        },
        search: {
          issuesAndPullRequests: searchIssuesMock,
        },
        issues: {
          listComments: listCommentsMock,
          updateComment: updateCommentMock,
          createComment: createCommentMock,
        },
      },
    });
    paginateMock.mockResolvedValue([]);
  });

  it.each([
    "[AI Auditor] HIGH: Unsafe external call (H-01)",
    "[Auto Prover] HIGH: Unsafe external call (H-01)",
  ])("deduplicates current and legacy issue title %s", async (title) => {
    searchIssuesMock.mockResolvedValue({
      data: { items: [{ number: 17, title }] },
    });
    const client = new GitHubClient("github-token");

    await expect(
      client.findExistingIssue({
        id: "H-01",
        title: "Unsafe external call",
        severity: "HIGH",
        locations: [],
        description: "Description",
        recommendation: "Recommendation",
      }),
    ).resolves.toBe(17);

    expect(searchIssuesMock).toHaveBeenCalledWith({
      q: 'repo:Certora/contracts is:issue is:open "H-01" in:title',
      per_page: 20,
    });
  });

  it("returns the UUID from an exact final commit-message trailer", async () => {
    const trailer = `Certora-Guardian-Run: ${RUN_ID}`;
    getCommitMock.mockResolvedValue({
      data: {
        sha: HEAD_SHA,
        commit: {
          message: `Add AutoProver artifacts for Vault\r\n\r\n${trailer}\r\n`,
        },
        parents: [{ sha: "a".repeat(40) }],
      },
    });
    const client = new GitHubClient("github-token");

    await expect(client.getGeneratedFollowup(HEAD_SHA)).resolves.toEqual({
      runId: RUN_ID,
      sourceCommitSha: "a".repeat(40),
    });

    expect(getOctokitMock).toHaveBeenCalledWith("github-token");
    expect(getCommitMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      ref: HEAD_SHA,
    });
    expect(infoMock).toHaveBeenCalledWith(
      `Detected generated-commit follow-up marker for Certora run ${RUN_ID}.`,
    );
  });

  it("paginates PR comments before updating the existing AutoProver Guardian comment", async () => {
    paginateMock.mockResolvedValue([
      { id: 101, body: "unrelated" },
      { id: 202, body: "<!-- autoprover-guardian-ci -->\nold result" },
    ]);
    const client = new GitHubClient("github-token");

    await client.upsertPrComment(42, "<!-- autoprover-guardian-ci -->\nnew result");

    expect(paginateMock).toHaveBeenCalledWith(listCommentsMock, {
      owner: "Certora",
      repo: "contracts",
      issue_number: 42,
      per_page: 100,
    });
    expect(updateCommentMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      comment_id: 202,
      body: "<!-- autoprover-guardian-ci -->\nnew result",
    });
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it("keeps comments for different workflows independent", async () => {
    paginateMock.mockResolvedValue([
      {
        id: 303,
        body: "<!-- certora-guardian-ci:auto-prover -->\nformal result",
      },
    ]);
    const client = new GitHubClient("github-token");
    const marker = "<!-- certora-guardian-ci:ai-auditor-diff -->";

    await client.upsertPrComment(42, `${marker}\ndiff result`, marker);

    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      issue_number: 42,
      body: `${marker}\ndiff result`,
    });
  });

  it.each([
    `Certora-Guardian-Run: ${RUN_ID}\nadditional text`,
    "Certora-Guardian-Run: run-1",
    ` Certora-Guardian-Run: ${RUN_ID}`,
    `certora-guardian-run: ${RUN_ID}`,
    `Certora-Guardian-Run: ${RUN_ID} `,
  ])(
    "ignores a commit message without the exact final trailer: %s",
    async (message) => {
      getCommitMock.mockResolvedValue({
        data: {
          sha: HEAD_SHA,
          commit: { message },
          parents: [{ sha: "a".repeat(40) }],
        },
      });
      const client = new GitHubClient("github-token");

      await expect(client.getGeneratedFollowup(HEAD_SHA)).resolves.toBeNull();
      expect(infoMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed when GitHub returns a different commit", async () => {
    getCommitMock.mockResolvedValue({
      data: {
        sha: "c".repeat(40),
        commit: {
          message: `Certora-Guardian-Run: ${RUN_ID}`,
        },
        parents: [{ sha: "a".repeat(40) }],
      },
    });
    const client = new GitHubClient("github-token");

    await expect(client.getGeneratedFollowup(HEAD_SHA)).rejects.toThrow(
      "Failed to inspect the pull request head commit. Refusing to launch a run that could duplicate a generated-commit follow-up.",
    );
  });

  it("does not expose GitHub response details when inspection fails", async () => {
    getCommitMock.mockRejectedValue(
      new Error("request failed with secret-token-value"),
    );
    const client = new GitHubClient("github-token");

    const error = await client
      .getGeneratedFollowup(HEAD_SHA)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Failed to inspect the pull request head commit.",
    );
    expect((error as Error).message).not.toContain("secret-token-value");
  });
});
