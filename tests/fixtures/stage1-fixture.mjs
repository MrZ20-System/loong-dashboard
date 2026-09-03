const TIME_ZONE = "Asia/Shanghai";

/**
 * Build logical metadata fixtures. The fake command turns these records into
 * GraphQL envelopes at runtime, so raw GitHub response dumps never live in
 * the repository.
 */
export function buildStage1Fixture(reference = new Date()) {
  reference = stableReference(reference);
  const activityDate = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
  }).format(reference);
  const timestamp = (offsetMs) =>
    new Date(reference.getTime() + offsetMs).toISOString();

  const alphaPullOpen = Array.from({ length: 56 }, (_, index) => {
    const number = 1_000 - index;
    return pullRequest({
      id: `ALPHA_PR_${number}`,
      number,
      title: `Alpha tie PR ${number}`,
      state: "OPEN",
      isDraft: number === 1_000,
      author: number === 999 ? null : { login: "alpha-author" },
      updatedAt: timestamp(-5 * 60 * 1_000),
      additions: 10 + (index % 4),
      deletions: 2 + (index % 3),
      changedFiles: 1 + (index % 2),
    });
  });

  const alphaPullClosed = [
    pullRequest({
      id: "ALPHA_PR_900",
      number: 900,
      title: "Alpha merged PR",
      state: "MERGED",
      mergedAt: timestamp(-60 * 60 * 1_000),
      closedAt: timestamp(-60 * 60 * 1_000),
      updatedAt: timestamp(-60 * 60 * 1_000),
      additions: 20,
      deletions: 5,
      changedFiles: 3,
    }),
    pullRequest({
      id: "ALPHA_PR_899",
      number: 899,
      title: "Alpha closed PR",
      state: "CLOSED",
      closedAt: timestamp(-70 * 60 * 1_000),
      updatedAt: timestamp(-70 * 60 * 1_000),
      additions: 8,
      deletions: 4,
      changedFiles: 2,
    }),
  ];

  const alphaIssueOpen = [
    issue({
      id: "ALPHA_ISSUE_300",
      number: 300,
      title: "Alpha issue with zero comments",
      state: "OPEN",
      author: null,
      updatedAt: timestamp(-8 * 60 * 1_000),
    }),
    issue({
      id: "ALPHA_ISSUE_299",
      number: 299,
      title: "Alpha second issue",
      state: "OPEN",
      updatedAt: timestamp(-9 * 60 * 1_000),
    }),
  ];
  const alphaIssueClosed = [
    issue({
      id: "ALPHA_ISSUE_298",
      number: 298,
      title: "Alpha closed issue",
      state: "CLOSED",
      updatedAt: timestamp(-70 * 60 * 1_000),
      closedAt: timestamp(-70 * 60 * 1_000),
    }),
  ];

  const alphaPullIncremental = [
    pullRequest({
      id: "ALPHA_PR_1099",
      number: 1_099,
      title: "Alpha incremental recent PR",
      state: "OPEN",
      updatedAt: watermarkTimestamp(-60 * 1_000),
    }),
    pullRequest({
      id: "ALPHA_PR_1100",
      number: 1_100,
      title: "Alpha incremental watermark equality PR",
      state: "OPEN",
      updatedAt: watermarkTimestamp(-120 * 1_000),
    }),
    pullRequest({
      id: "ALPHA_PR_1098",
      number: 1_098,
      title: "Alpha incremental older PR (must stop)",
      state: "OPEN",
      updatedAt: watermarkTimestamp(-120_001),
    }),
  ];
  const alphaIssueIncremental = [
    issue({
      id: "ALPHA_ISSUE_399",
      number: 399,
      title: "Alpha incremental recent issue",
      state: "OPEN",
      updatedAt: watermarkTimestamp(-60 * 1_000),
    }),
    issue({
      id: "ALPHA_ISSUE_400",
      number: 400,
      title: "Alpha incremental watermark equality issue",
      state: "OPEN",
      updatedAt: watermarkTimestamp(-120 * 1_000),
    }),
    issue({
      id: "ALPHA_ISSUE_398",
      number: 398,
      title: "Alpha incremental older issue (must stop)",
      state: "OPEN",
      updatedAt: watermarkTimestamp(-120_001),
    }),
  ];

  const betaPullOpen = [
    pullRequest({
      id: "BETA_PR_20",
      number: 20,
      title: "Beta open PR",
      state: "OPEN",
      updatedAt: timestamp(-6 * 60 * 1_000),
      additions: 4,
      deletions: 1,
      changedFiles: 1,
    }),
    pullRequest({
      id: "BETA_PR_19",
      number: 19,
      title: "Beta draft PR",
      state: "OPEN",
      isDraft: true,
      updatedAt: timestamp(-7 * 60 * 1_000),
      additions: 2,
      deletions: 0,
      changedFiles: 1,
    }),
  ];
  const betaPullClosed = [
    pullRequest({
      id: "BETA_PR_18",
      number: 18,
      title: "Beta merged PR",
      state: "MERGED",
      mergedAt: timestamp(-80 * 60 * 1_000),
      closedAt: timestamp(-80 * 60 * 1_000),
      updatedAt: timestamp(-80 * 60 * 1_000),
      additions: 5,
      deletions: 2,
      changedFiles: 1,
    }),
  ];
  const betaIssueOpen = [
    issue({
      id: "BETA_ISSUE_20",
      number: 20,
      title: "Beta issue",
      state: "OPEN",
      updatedAt: timestamp(-10 * 60 * 1_000),
    }),
  ];
  const betaIssueClosed = [];

  return {
    version: 1,
    activityDate,
    repositories: {
      alpha: {
        repositoryId: "alpha",
        github: "acme/alpha",
        streams: {
          "pulls|bootstrap|OPEN": stream([page(alphaPullOpen)]),
          "pulls|bootstrap|CLOSED,MERGED": stream([page(alphaPullClosed)]),
          "issues|bootstrap|OPEN": stream([page(alphaIssueOpen)]),
          "issues|bootstrap|CLOSED": stream([page(alphaIssueClosed)]),
          "pulls|incremental-1|OPEN,CLOSED,MERGED": incrementalStream(
            alphaPullIncremental,
            "alpha-pulls-incremental-1",
          ),
          "pulls|incremental-2|OPEN,CLOSED,MERGED": incrementalStream(
            alphaPullIncremental,
            "alpha-pulls-incremental-2",
          ),
          "issues|incremental-1|OPEN,CLOSED": incrementalStream(
            alphaIssueIncremental,
            "alpha-issues-incremental-1",
          ),
        },
      },
      beta: {
        repositoryId: "beta",
        github: "acme/beta",
        streams: {
          "pulls|bootstrap|OPEN": stream([page(betaPullOpen)]),
          "pulls|bootstrap|CLOSED,MERGED": stream([page(betaPullClosed)]),
          "issues|bootstrap|OPEN": stream([page(betaIssueOpen)]),
          "issues|bootstrap|CLOSED": stream([page(betaIssueClosed)]),
        },
      },
    },
    failures: [
      {
        repositoryId: "alpha",
        operation: "issues",
        generation: "incremental-2",
        states: "OPEN,CLOSED",
        cursor: null,
        exitCode: 23,
        stderr: "fixture issue stream failure",
      },
    ],
  };

  function watermarkTimestamp(offsetMs) {
    return { $timestamp: "watermark", offsetMs };
  }
}

function stableReference(value) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const datePart = (type) => parts.find((part) => part.type === type)?.value;
  const year = Number(datePart("year"));
  const month = Number(datePart("month"));
  const day = Number(datePart("day"));
  if (![year, month, day].every(Number.isInteger)) {
    throw new Error("fixture reference must be a valid date");
  }
  // Asia/Shanghai is UTC+08:00; noon leaves ample room for fixture offsets
  // without crossing the activity date boundary.
  return new Date(Date.UTC(year, month - 1, day, 4, 0, 0, 0));
}

function stream(pages) {
  return { pages };
}

function incrementalStream(items, endCursor) {
  return stream([
    page(items, { hasNextPage: true, endCursor }),
  ]);
}

function page(nodes, pageInfo = { hasNextPage: false, endCursor: null }) {
  return { nodes, pageInfo };
}

function pullRequest({
  id,
  number,
  title,
  state,
  isDraft = false,
  author = { login: "fixture-author" },
  createdAt = "2020-01-01T00:00:00.000Z",
  updatedAt,
  closedAt = null,
  mergedAt = null,
  additions = 6,
  deletions = 3,
  changedFiles = 2,
}) {
  return {
    id,
    number,
    title,
    url: `https://github.com/acme/fixture/pull/${number}`,
    state,
    isDraft,
    author,
    createdAt,
    updatedAt,
    closedAt,
    mergedAt,
    baseRefName: "main",
    headRefName: `fixture/pr-${number}`,
    headRefOid: `${number.toString(16).padStart(40, "0")}`,
    additions,
    deletions,
    changedFiles,
  };
}

function issue({
  id,
  number,
  title,
  state,
  author = { login: "fixture-author" },
  createdAt = "2020-01-01T00:00:00.000Z",
  updatedAt,
  closedAt = null,
}) {
  return {
    id,
    number,
    title,
    url: `https://github.com/acme/fixture/issues/${number}`,
    state,
    author,
    comments: { totalCount: 0 },
    createdAt,
    updatedAt,
    closedAt,
  };
}

export function stage1RepositoryConfigs() {
  return [
    {
      key: "alpha",
      name: "Alpha Fixture",
      github: "acme/alpha",
      path: "repositories/alpha",
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
    {
      key: "beta",
      name: "Beta Fixture",
      github: "acme/beta",
      path: "repositories/beta",
      remote: "origin",
      defaultBranch: "main",
      worktreeSlots: 1,
    },
  ];
}
