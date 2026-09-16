import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  createCommentMock,
  getCommitMock,
  getOctokitMock,
  getPullMock,
  getRefMock,
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
  getRefMock: vi.fn(),
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
        git: { getRef: getRefMock },
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

  describe("live diff source verification", () => {
    const baseSha = "c".repeat(40);
    const source = {
      prNumber: 42,
      repositoryUrl: "https://github.com/Certora/contracts",
      baseBranchName: "release/2026",
      headBranchName: "feature/review",
      headCommitSha: HEAD_SHA,
    };
    const currentPull = () => ({
      number: 42, state: "open", merged: false,
      merge_commit_sha: "d".repeat(40),
      base: { ref: source.baseBranchName, sha: "a".repeat(40), repo: { full_name: "Certora/contracts" } },
      head: { ref: source.headBranchName, sha: HEAD_SHA, repo: { full_name: "Certora/contracts" } },
    });

    beforeEach(() => {
      getPullMock.mockResolvedValue({ data: currentPull() });
      getRefMock.mockImplementation(async ({ ref }) => ({ data: {
        ref: `refs/${ref}`,
        object: { type: "commit", sha: ref === `heads/${source.baseBranchName}` ? baseSha : HEAD_SHA },
      } }));
    });

    it("pins the latest base and PR branch tips, never event base or merge SHA", async () => {
      await expect(new GitHubClient("token").resolveDiffSource(source)).resolves.toEqual({ baseCommitSha: baseSha, headCommitSha: HEAD_SHA });
      expect(getPullMock).toHaveBeenCalledWith({ owner: "Certora", repo: "contracts", pull_number: 42, request: { signal: expect.any(AbortSignal) } });
      expect(getRefMock.mock.calls.map(([arg]) => arg.ref)).toEqual(["heads/release/2026", "heads/feature/review"]);
      expect(getRefMock.mock.calls.every(([arg]) => arg.request.signal instanceof AbortSignal)).toBe(true);
    });

    it("bounds every GitHub read by the remaining workflow deadline", async () => {
      const timeout = vi.spyOn(AbortSignal, "timeout");
      try {
        await new GitHubClient("token").resolveDiffSource({ ...source, deadlineMs: Date.now() + 500 });
        expect(timeout).toHaveBeenCalledTimes(3);
        for (const [milliseconds] of timeout.mock.calls) {
          expect(milliseconds).toBeGreaterThan(0);
          expect(milliseconds).toBeLessThanOrEqual(500);
        }
      } finally {
        timeout.mockRestore();
      }
    });

    it("aborts a hanging GitHub read instead of proceeding to audit launch", async () => {
      getPullMock.mockImplementation(({ request }) => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(new Error("Aborted")), { once: true });
      }));
      await expect(new GitHubClient("token").resolveDiffSource({ ...source, deadlineMs: Date.now() + 20 })).rejects.toThrow("No audit was launched");
      expect(getRefMock).not.toHaveBeenCalled();
    });

    it("does not start a GitHub read after the workflow deadline", async () => {
      await expect(new GitHubClient("token").resolveDiffSource({ ...source, deadlineMs: Date.now() - 1 })).rejects.toThrow("timeout expired");
      expect(getPullMock).not.toHaveBeenCalled();
      expect(getRefMock).not.toHaveBeenCalled();
    });

    it.each([
      ["closed", { state: "closed" }],
      ["merged", { merged: true }],
      ["wrong PR", { number: 43 }],
      ["retargeted", { base: { ...currentPull().base, ref: "other" } }],
      ["wrong base repo", { base: { ...currentPull().base, repo: { full_name: "Other/contracts" } } }],
      ["fork", { head: { ...currentPull().head, repo: { full_name: "Other/contracts" } } }],
      ["deleted head repo", { head: { ...currentPull().head, repo: null } }],
      ["wrong head ref", { head: { ...currentPull().head, ref: "other" } }],
    ])("rejects a %s PR before resolving refs", async (_label, change) => {
      getPullMock.mockResolvedValue({ data: { ...currentPull(), ...change } });
      await expect(new GitHubClient("token").resolveDiffSource(source)).rejects.toThrow("No audit was launched");
      expect(getRefMock).not.toHaveBeenCalled();
    });

    it("rejects an old event instead of silently auditing the new PR head", async () => {
      getPullMock.mockResolvedValue({ data: { ...currentPull(), head: { ...currentPull().head, sha: "d".repeat(40) } } });
      await expect(new GitHubClient("token").resolveDiffSource(source)).rejects.toThrow("stale event");
      expect(getRefMock).not.toHaveBeenCalled();
    });

    it("rejects a head that advances while checking refs", async () => {
      getRefMock.mockResolvedValueOnce({ data: { ref: `refs/heads/${source.baseBranchName}`, object: { type: "commit", sha: baseSha } } });
      getRefMock.mockResolvedValueOnce({ data: { ref: `refs/heads/${source.headBranchName}`, object: { type: "commit", sha: "d".repeat(40) } } });
      await expect(new GitHubClient("token").resolveDiffSource(source)).rejects.toThrow("head changed while verifying");
    });

    it.each([
      { ref: "refs/heads/wrong", object: { type: "commit", sha: baseSha } },
      { ref: `refs/heads/${source.baseBranchName}`, object: { type: "tag", sha: baseSha } },
      { ref: `refs/heads/${source.baseBranchName}`, object: { type: "commit", sha: "main" } },
    ])("rejects an ambiguous exact branch-ref response %#", async (reference) => {
      getRefMock.mockResolvedValueOnce({ data: reference });
      await expect(new GitHubClient("token").resolveDiffSource(source)).rejects.toThrow("invalid branch reference");
    });

    it.each([403, 404, 429, 500])("fails closed on GitHub HTTP %i", async (status) => {
      getRefMock.mockRejectedValueOnce({ status, message: "credential must not leak" });
      await expect(new GitHubClient("token").resolveDiffSource(source)).rejects.toThrow(`GitHub HTTP ${status}`);
    });

    it("sanitizes network errors rather than falling back to event commits", async () => {
      getPullMock.mockRejectedValue(new Error("No audit was launched: secret token"));
      await expect(new GitHubClient("token").resolveDiffSource(source)).rejects.toThrow("Could not verify the current pull request branches. No audit was launched");
    });

    it.each(["", "../main", "refs/heads/main", "main?ref=other", "main\nother"])("rejects unsafe branch identity %j before GitHub reads", async (baseBranchName) => {
      await expect(new GitHubClient("token").resolveDiffSource({ ...source, baseBranchName })).rejects.toThrow("Cannot verify diff review branch identities");
      expect(getPullMock).not.toHaveBeenCalled();
    });
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

  it.each(["\n", "\r\n"])(
    "returns the UUID from the exact final commit-message trailer with %j line endings",
    async (lineEnding) => {
      getCommitMock.mockResolvedValue({
        data: {
          sha: HEAD_SHA,
          commit: {
            message: `Add AutoProver artifacts for Vault${lineEnding}${lineEnding}Certora-Guardian-Run: ${RUN_ID}${lineEnding}`,
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
    `Zeus-Guardian-Job: ${RUN_ID}`,
    `Add AutoProver artifacts for Vault\r\n\r\nZeus-Guardian-Job: ${RUN_ID}\r\n`,
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
