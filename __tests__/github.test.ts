import { beforeEach, describe, expect, it, vi } from "vitest";

const { getCommitMock, getOctokitMock, infoMock, searchIssuesMock } =
  vi.hoisted(() => ({
    getCommitMock: vi.fn(),
    getOctokitMock: vi.fn(),
    infoMock: vi.fn(),
    searchIssuesMock: vi.fn(),
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
const JOB_ID = "11111111-1111-4111-8111-111111111111";

describe("GitHubClient", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getOctokitMock.mockReturnValue({
      rest: {
        repos: {
          getCommit: getCommitMock,
        },
        search: {
          issuesAndPullRequests: searchIssuesMock,
        },
      },
    });
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
    getCommitMock.mockResolvedValue({
      data: {
        sha: HEAD_SHA,
        commit: {
          message: `Add AutoProver artifacts for Vault\r\n\r\nZeus-Guardian-Job: ${JOB_ID}\r\n`,
        },
      },
    });
    const client = new GitHubClient("github-token");

    await expect(client.getGeneratedFollowupJobId(HEAD_SHA)).resolves.toBe(
      JOB_ID,
    );

    expect(getOctokitMock).toHaveBeenCalledWith("github-token");
    expect(getCommitMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      ref: HEAD_SHA,
    });
    expect(infoMock).toHaveBeenCalledWith(
      `Detected generated-commit follow-up marker for Zeus job ${JOB_ID}.`,
    );
  });

  it.each([
    `Zeus-Guardian-Job: ${JOB_ID}\nadditional text`,
    "Zeus-Guardian-Job: job-1",
    ` Zeus-Guardian-Job: ${JOB_ID}`,
    `zeus-guardian-job: ${JOB_ID}`,
    `Zeus-Guardian-Job: ${JOB_ID} `,
  ])(
    "ignores a commit message without the exact final trailer: %s",
    async (message) => {
      getCommitMock.mockResolvedValue({
        data: {
          sha: HEAD_SHA,
          commit: { message },
        },
      });
      const client = new GitHubClient("github-token");

      await expect(
        client.getGeneratedFollowupJobId(HEAD_SHA),
      ).resolves.toBeNull();
      expect(infoMock).not.toHaveBeenCalled();
    },
  );

  it("fails closed when GitHub returns a different commit", async () => {
    getCommitMock.mockResolvedValue({
      data: {
        sha: "c".repeat(40),
        commit: {
          message: `Zeus-Guardian-Job: ${JOB_ID}`,
        },
      },
    });
    const client = new GitHubClient("github-token");

    await expect(client.getGeneratedFollowupJobId(HEAD_SHA)).rejects.toThrow(
      "Failed to inspect the pull request head commit. Refusing to launch an audit that could duplicate a generated-commit follow-up.",
    );
  });

  it("does not expose GitHub response details when inspection fails", async () => {
    getCommitMock.mockRejectedValue(
      new Error("request failed with secret-token-value"),
    );
    const client = new GitHubClient("github-token");

    const error = await client
      .getGeneratedFollowupJobId(HEAD_SHA)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      "Failed to inspect the pull request head commit.",
    );
    expect((error as Error).message).not.toContain("secret-token-value");
  });
});
