import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createCommentMock,
  getCommitMock,
  getOctokitMock,
  getPullMock,
  graphqlMock,
  infoMock,
  listCommentsMock,
  paginateMock,
  searchIssuesMock,
  updateCommentMock,
  warningMock,
} = vi.hoisted(() => ({
  createCommentMock: vi.fn(),
  getCommitMock: vi.fn(),
  getOctokitMock: vi.fn(),
  getPullMock: vi.fn(),
  graphqlMock: vi.fn(),
  infoMock: vi.fn(),
  listCommentsMock: vi.fn(),
  paginateMock: vi.fn(),
  searchIssuesMock: vi.fn(),
  updateCommentMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@actions/core", () => ({
  info: infoMock,
  warning: warningMock,
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
const MARKER = "<!-- certora-guardian-ci:ai-auditor-diff -->";
const scopedMarker = (marker = MARKER, head = HEAD_SHA, runId = RUN_ID) =>
  marker.replace(/ -->$/, `:head:${head}:run:${runId} -->`);
const ownedComment = (id: number, body: string) => ({
  id,
  node_id: `comment-${id}`,
  body,
});
const FINDING = {
  id: "H-01",
  title: "Unsafe external call",
  severity: "HIGH" as const,
  locations: [],
  description: "Description",
  recommendation: "Recommendation",
};

describe("GitHubClient", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    getOctokitMock.mockReturnValue({
      paginate: paginateMock,
      graphql: graphqlMock,
      rest: {
        pulls: {
          get: getPullMock,
        },
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
    getPullMock.mockResolvedValue({ data: { head: { sha: HEAD_SHA } } });
    graphqlMock.mockImplementation(async (_query, { ids }) => ({
      nodes: ids.map((id: string) => ({
        id,
        body: `${scopedMarker()}\nold result`,
        viewerDidAuthor: true,
      })),
    }));
  });

  it.each([
    "[AI Auditor] HIGH: Unsafe external call (H-01)",
    "[Auto Prover] HIGH: Unsafe external call (H-01)",
  ])("deduplicates current and legacy issue title %s", async (title) => {
    searchIssuesMock.mockResolvedValue({
      data: {
        items: [
          {
            number: 17,
            title,
            repository_url: "https://api.github.com/repos/Certora/contracts",
          },
        ],
      },
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

  it.each([
    'H-01" OR repo:other/repository "',
    "H-01\nin:body",
    "H".repeat(129),
    "",
  ])(
    "does not interpolate untrusted finding ID %j into search syntax",
    async (id) => {
      const client = new GitHubClient("github-token");

      await expect(
        client.findExistingIssue({ ...FINDING, id }),
      ).resolves.toBeNull();

      expect(searchIssuesMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    { repository_url: "https://api.github.com/repos/other/repository" },
    {
      repository_url: "https://api.github.com/repos/Certora/contracts",
      pull_request: {},
    },
  ])(
    "does not reuse another repository's issue or a pull request: %j",
    async (extra) => {
      searchIssuesMock.mockResolvedValue({
        data: {
          items: [
            {
              number: 17,
              title: "[AI Auditor] HIGH: Unsafe external call (H-01)",
              ...extra,
            },
          ],
        },
      });
      const client = new GitHubClient("github-token");

      await expect(client.findExistingIssue(FINDING)).resolves.toBeNull();
    },
  );

  it.each([
    ["current", `Certora-Guardian-Run: ${RUN_ID}`],
    ["legacy protocol", `Zeus-Guardian-Job: ${RUN_ID}`],
  ])(
    "returns the UUID from an exact final %s commit-message trailer",
    async (_kind, trailer) => {
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
    },
  );

  it("paginates PR comments and verifies ownership before updating its own scoped summary", async () => {
    paginateMock.mockResolvedValue([
      { id: 101, body: "unrelated" },
      ownedComment(202, `${scopedMarker()}\nold result`),
    ]);
    const client = new GitHubClient("github-token");

    await client.upsertPrComment(
      42,
      `${MARKER}\nnew result`,
      MARKER,
      HEAD_SHA,
      RUN_ID,
    );

    expect(paginateMock).toHaveBeenCalledWith(listCommentsMock, {
      owner: "Certora",
      repo: "contracts",
      issue_number: 42,
      per_page: 100,
    });
    expect(graphqlMock).toHaveBeenCalledWith(
      expect.stringContaining("viewerDidAuthor"),
      { ids: ["comment-202"] },
    );
    expect(updateCommentMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      comment_id: 202,
      body: `${scopedMarker()}\nnew result`,
    });
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it.each([
    "<!-- zeus-guardian-ci -->",
    "<!-- autoprover-guardian-ci -->",
    MARKER,
  ])("leaves legacy unscoped summary %s untouched", async (legacyMarker) => {
    paginateMock.mockResolvedValue([
      ownedComment(202, `${legacyMarker}\nold result`),
    ]);
    const client = new GitHubClient("github-token");
    const marker = "<!-- certora-guardian-ci:ai-auditor-diff -->";
    const body = `${marker}\nnew result`;

    await client.upsertPrComment(42, body, marker, HEAD_SHA, RUN_ID);

    expect(createCommentMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      issue_number: 42,
      body: `${scopedMarker()}\nnew result`,
    });
    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(graphqlMock).not.toHaveBeenCalled();
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

    await client.upsertPrComment(
      42,
      `${marker}\ndiff result`,
      marker,
      HEAD_SHA,
      RUN_ID,
    );

    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      issue_number: 42,
      body: `${scopedMarker()}\ndiff result`,
    });
  });

  it.each([
    scopedMarker(),
    "<!-- certora-guardian-ci:ai-auditor-diff -->",
    "<!-- autoprover-guardian-ci -->",
    "<!-- zeus-guardian-ci -->",
  ])(
    "ignores nested or quoted marker %s in unrelated report contents",
    async (nestedMarker) => {
      paginateMock.mockResolvedValue([
        {
          id: 303,
          body: `<!-- certora-guardian-ci:auto-prover -->\nReport quotes this text:\n${nestedMarker}`,
        },
        { id: 304, body: `Quoted inline: ${nestedMarker}` },
      ]);
      const client = new GitHubClient("github-token");
      const marker = "<!-- certora-guardian-ci:ai-auditor-diff -->";

      await client.upsertPrComment(
        42,
        `${marker}\ndiff result`,
        marker,
        HEAD_SHA,
        RUN_ID,
      );

      expect(updateCommentMock).not.toHaveBeenCalled();
      expect(createCommentMock).toHaveBeenCalledOnce();
    },
  );

  it("recognizes a complete leading marker line with Windows line endings", async () => {
    const marker = "<!-- certora-guardian-ci:ai-auditor-diff -->";
    paginateMock.mockResolvedValue([
      ownedComment(202, `${scopedMarker()}\r\nold result`),
    ]);
    const client = new GitHubClient("github-token");

    await client.upsertPrComment(
      42,
      `${marker}\nnew result`,
      marker,
      HEAD_SHA,
      RUN_ID,
    );

    expect(updateCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 202 }),
    );
    expect(createCommentMock).not.toHaveBeenCalled();
  });

  it.each(["github-actions[bot]", "custom-installation[bot]", "pat-owner"])(
    "uses authenticated ownership, not a hardcoded author login: %s",
    async (login) => {
      paginateMock.mockResolvedValue([
        {
          ...ownedComment(202, `${scopedMarker()}\nold result`),
          user: { login, type: login.endsWith("[bot]") ? "Bot" : "User" },
        },
      ]);
      const client = new GitHubClient("github-token");

      await client.upsertPrComment(
        42,
        `${MARKER}\nnew result`,
        MARKER,
        HEAD_SHA,
        RUN_ID,
      );

      expect(updateCommentMock).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 202 }),
      );
      expect(createCommentMock).not.toHaveBeenCalled();
    },
  );

  it.each(["User", "Bot"])(
    "ignores an exact-marker impersonator with author type %s and finds its own comment",
    async (type) => {
      paginateMock.mockResolvedValue([
        {
          ...ownedComment(101, `${scopedMarker()}\nspoof`),
          user: { login: "impersonator", type },
        },
        ownedComment(202, `${scopedMarker()}\nreal old result`),
      ]);
      graphqlMock.mockResolvedValue({
        nodes: [
          {
            id: "comment-101",
            body: `${scopedMarker()}\nspoof`,
            viewerDidAuthor: false,
          },
          {
            id: "comment-202",
            body: `${scopedMarker()}\nreal old result`,
            viewerDidAuthor: true,
          },
        ],
      });
      const client = new GitHubClient("github-token");

      await client.upsertPrComment(
        42,
        `${MARKER}\nnew result`,
        MARKER,
        HEAD_SHA,
        RUN_ID,
      );

      expect(updateCommentMock).toHaveBeenCalledWith(
        expect.objectContaining({ comment_id: 202 }),
      );
      expect(createCommentMock).not.toHaveBeenCalled();
    },
  );

  it("creates its own summary instead of trusting an impersonated exact marker", async () => {
    paginateMock.mockResolvedValue([
      ownedComment(101, `${scopedMarker()}\nspoof`),
    ]);
    graphqlMock.mockResolvedValue({
      nodes: [
        {
          id: "comment-101",
          body: `${scopedMarker()}\nspoof`,
          viewerDidAuthor: false,
        },
      ],
    });

    await new GitHubClient("github-token").upsertPrComment(
      42,
      `${MARKER}\nnew result`,
      MARKER,
      HEAD_SHA,
      RUN_ID,
    );

    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(createCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ body: `${scopedMarker()}\nnew result` }),
    );
  });

  it("checks ownership in bounded batches when many comments impersonate its marker", async () => {
    const comments = Array.from({ length: 101 }, (_, i) =>
      ownedComment(i + 1, `${scopedMarker()}\nresult`),
    );
    paginateMock.mockResolvedValue(comments);
    graphqlMock.mockImplementation(async (_query, { ids }) => ({
      nodes: ids.map((id: string) => ({
        id,
        body: `${scopedMarker()}\nresult`,
        viewerDidAuthor: id === "comment-101",
      })),
    }));

    await new GitHubClient("github-token").upsertPrComment(
      42,
      `${MARKER}\nnew result`,
      MARKER,
      HEAD_SHA,
      RUN_ID,
    );

    expect(graphqlMock).toHaveBeenCalledTimes(2);
    expect(graphqlMock.mock.calls[0]?.[1].ids).toHaveLength(100);
    expect(graphqlMock.mock.calls[1]?.[1].ids).toEqual(["comment-101"]);
    expect(updateCommentMock).toHaveBeenCalledWith(
      expect.objectContaining({ comment_id: 101 }),
    );
  });

  it.each([
    { nodes: [null] },
    {
      nodes: [
        {
          id: "comment-202",
          body: `${MARKER}\nchanged marker`,
          viewerDidAuthor: true,
        },
      ],
    },
    {
      nodes: [
        {
          id: "unknown-node",
          body: `${scopedMarker()}\nresult`,
          viewerDidAuthor: true,
        },
      ],
    },
  ])(
    "does not update an identity that changed or disappeared during verification: %j",
    async (response) => {
      paginateMock.mockResolvedValue([
        ownedComment(202, `${scopedMarker()}\nold result`),
      ]);
      graphqlMock.mockResolvedValue(response);

      await new GitHubClient("github-token").upsertPrComment(
        42,
        `${MARKER}\nnew result`,
        MARKER,
        HEAD_SHA,
        RUN_ID,
      );

      expect(updateCommentMock).not.toHaveBeenCalled();
      expect(createCommentMock).toHaveBeenCalledOnce();
    },
  );

  it("fails closed without exposing secrets when ownership cannot be verified", async () => {
    paginateMock.mockResolvedValue([
      ownedComment(202, `${scopedMarker()}\nold result`),
    ]);
    graphqlMock.mockRejectedValue(new Error("sensitive-source-and-token"));

    await new GitHubClient("github-token").upsertPrComment(
      42,
      `${MARKER}\nnew result`,
      MARKER,
      HEAD_SHA,
      RUN_ID,
    );

    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(warningMock).toHaveBeenCalledWith("Failed to upsert PR comment.");
    expect(JSON.stringify(warningMock.mock.calls)).not.toContain(
      "sensitive-source-and-token",
    );
  });

  it("skips a late old-head result before reading or mutating comments", async () => {
    getPullMock.mockResolvedValue({ data: { head: { sha: "c".repeat(40) } } });

    await new GitHubClient("github-token").upsertPrComment(
      42,
      `${MARKER}\nnew result`,
      MARKER,
      HEAD_SHA,
      RUN_ID,
    );

    expect(getPullMock).toHaveBeenCalledWith({
      owner: "Certora",
      repo: "contracts",
      pull_number: 42,
    });
    expect(paginateMock).not.toHaveBeenCalled();
    expect(updateCommentMock).not.toHaveBeenCalled();
    expect(createCommentMock).not.toHaveBeenCalled();
    expect(infoMock).toHaveBeenCalledWith(
      "Skipped PR summary because the pull request head has changed.",
    );
  });

  it.each([true, false])(
    "rechecks head immediately before %s existing-comment mutation",
    async (existing) => {
      getPullMock
        .mockResolvedValueOnce({ data: { head: { sha: HEAD_SHA } } })
        .mockResolvedValueOnce({ data: { head: { sha: "c".repeat(40) } } });
      if (existing)
        paginateMock.mockResolvedValue([
          ownedComment(202, `${scopedMarker()}\nold result`),
        ]);

      await new GitHubClient("github-token").upsertPrComment(
        42,
        `${MARKER}\nnew result`,
        MARKER,
        HEAD_SHA,
        RUN_ID,
      );

      expect(getPullMock).toHaveBeenCalledTimes(2);
      expect(updateCommentMock).not.toHaveBeenCalled();
      expect(createCommentMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    scopedMarker(MARKER, "c".repeat(40)),
    scopedMarker(MARKER, HEAD_SHA, "22222222-2222-4222-8222-222222222222"),
    scopedMarker("<!-- certora-guardian-ci:ai-auditor-diff:frontier -->"),
  ])(
    "cannot overwrite a different head, paid audit, or mode even across a final-read race: %s",
    async (newerMarker) => {
      // The old expected head is returned by both reads, as if the head advanced
      // immediately after the final GET. Identity still excludes newer summaries.
      paginateMock.mockResolvedValue([
        ownedComment(202, `${newerMarker}\nnewer result`),
      ]);

      await new GitHubClient("github-token").upsertPrComment(
        42,
        `${MARKER}\nold result`,
        MARKER,
        HEAD_SHA,
        RUN_ID,
      );

      expect(updateCommentMock).not.toHaveBeenCalled();
      expect(graphqlMock).not.toHaveBeenCalled();
      expect(createCommentMock).toHaveBeenCalledWith(
        expect.objectContaining({ body: `${scopedMarker()}\nold result` }),
      );
    },
  );

  it.each([
    ["main", RUN_ID, `${MARKER}\nreport`],
    [HEAD_SHA, "not-a-run-id", `${MARKER}\nreport`],
    [HEAD_SHA, RUN_ID, "unmarked report"],
  ])(
    "fails closed for invalid publication identity: %j",
    async (head, runId, body) => {
      await new GitHubClient("github-token").upsertPrComment(
        42,
        body!,
        MARKER,
        head!,
        runId!,
      );

      expect(getPullMock).not.toHaveBeenCalled();
      expect(updateCommentMock).not.toHaveBeenCalled();
      expect(createCommentMock).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error("request body included sensitive-source-and-token"),
    {
      status: 403,
      message: "sensitive-source-and-token",
      response: { data: "sensitive-source-and-token" },
    },
  ])(
    "does not expose GitHub exceptions in publication warnings",
    async (error) => {
      searchIssuesMock.mockRejectedValue(error);
      createCommentMock.mockRejectedValue(error);
      const client = new GitHubClient("github-token");

      await client.findExistingIssue(FINDING);
      await client.upsertPrComment(
        42,
        `${MARKER}\nreport`,
        MARKER,
        HEAD_SHA,
        RUN_ID,
      );
      vi.spyOn(client, "findExistingIssue").mockRejectedValueOnce(error);
      await client.createOrUpdateIssue(FINDING, RUN_ID, 42, []);

      expect(warningMock).toHaveBeenCalledTimes(3);
      expect(JSON.stringify(warningMock.mock.calls)).not.toContain(
        "sensitive-source-and-token",
      );
      if ("status" in error) {
        expect(warningMock).toHaveBeenCalledWith(
          "Failed to upsert PR comment (GitHub HTTP 403).",
        );
      }
    },
  );

  it.each([
    `Certora-Guardian-Run: ${RUN_ID}\nadditional text`,
    "Certora-Guardian-Run: run-1",
    ` Certora-Guardian-Run: ${RUN_ID}`,
    `certora-guardian-run: ${RUN_ID}`,
    `Certora-Guardian-Run: ${RUN_ID} `,
    `Zeus-Guardian-Job: ${RUN_ID}\nadditional text`,
    `zeus-guardian-job: ${RUN_ID}`,
    `Zeus-Guardian-Job: ${RUN_ID} `,
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

  it.each([
    [],
    [{ sha: "a".repeat(40) }, { sha: "c".repeat(40) }],
    [{ sha: "main" }],
    [{}],
  ])(
    "rejects a generated follow-up without exactly one immutable parent: %j",
    async (parents) => {
      getCommitMock.mockResolvedValue({
        data: {
          sha: HEAD_SHA,
          commit: { message: `Certora-Guardian-Run: ${RUN_ID}` },
          parents,
        },
      });
      const client = new GitHubClient("github-token");

      await expect(client.getGeneratedFollowup(HEAD_SHA)).rejects.toThrow(
        "Refusing to launch a run that could duplicate a generated-commit follow-up.",
      );
      expect(infoMock).not.toHaveBeenCalled();
    },
  );

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
