import { pathToFileURL } from "node:url";

const CURRENT_REPOSITORY = "dicoeeee/devhot-site";
const branchPattern = /^codex\/issue-(?<issue>[1-9][0-9]*)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const issueReferencePattern =
  /^[ \t]*Refs[ \t]+dicoeeee\/devhot#(?<issue>[1-9][0-9]*)[ \t]*$/gm;
const closingKeywordPattern =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:(?:dicoeeee\/devhot)?#[1-9][0-9]*|https:\/\/github\.com\/dicoeeee\/devhot\/issues\/[1-9][0-9]*)\b/i;
const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const shaPattern = /^[0-9a-f]{40}$/;
const actionsRunPattern =
  /^https:\/\/github\.com\/dicoeeee\/devhot\/actions\/runs\/[1-9][0-9]*$/;
const pullRequestUrlPattern =
  /^https:\/\/github\.com\/(?<repository>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(?<number>[1-9][0-9]*)$/;

interface DeliveryScope {
  repositories: string[];
}

interface Counterpart {
  repository: string;
  branch: string;
  pullRequestUrl: string;
  sha: string;
}

interface CrossRepositoryDelivery {
  state: string;
  counterparts: Counterpart[];
  mergeBlockers: string[];
  candidatePreflight: string;
}

export interface PullRequestMetadata {
  baseRef: string;
  headRef: string;
  body: string;
  isDraft: boolean;
}

const sectionLines = (
  body: string,
  heading: string,
): { present: boolean; lines: string[] } => {
  const lines = body.split(/\r?\n/);
  const headingPattern = new RegExp(`^ {0,3}##[ \\t]+${heading}(?:[ \\t]+#+)?[ \\t]*$`);
  const headings = lines.flatMap((line, index) =>
    headingPattern.test(line) ? [index] : [],
  );
  if (headings.length === 0) return { present: false, lines: [] };
  if (headings.length !== 1) return { present: true, lines: [] };

  const start = headings[0]! + 1;
  const relativeEnd = lines
    .slice(start)
    .findIndex((line) => /^ {0,3}##(?:[ \t]+|$)/.test(line));
  const end = relativeEnd === -1 ? lines.length : start + relativeEnd;
  return {
    present: true,
    lines: lines.slice(start, end).filter((line) => line.length > 0),
  };
};

const parseDeliveryScope = (body: string): DeliveryScope | undefined => {
  const section = sectionLines(body, "Delivery scope");
  const lines = section.lines;
  if (
    !section.present ||
    lines.length < 6 ||
    !lines[0]?.startsWith("- Delivery type: ")
  ) {
    return undefined;
  }
  if (lines[1] !== "- Repositories:") return undefined;

  let repositoryEnd = 2;
  const repositories: string[] = [];
  while (lines[repositoryEnd]?.startsWith("  - ")) {
    const repository = lines[repositoryEnd]!.slice("  - ".length).trim();
    if (!repositoryPattern.test(repository)) return undefined;
    repositories.push(repository);
    repositoryEnd += 1;
  }

  const remaining = lines.slice(repositoryEnd);
  if (
    repositories.length === 0 ||
    new Set(repositories).size !== repositories.length ||
    remaining.length !== 3 ||
    !remaining[0]?.startsWith("- Contract change: ") ||
    !remaining[1]?.startsWith("- Required gates: ") ||
    !remaining[2]?.startsWith("- Blocking issues: ")
  ) {
    return undefined;
  }

  const deliveryType = lines[0].slice("- Delivery type: ".length).trim();
  const contractChange = remaining[0].slice("- Contract change: ".length).trim();
  const requiredGates = remaining[1].slice("- Required gates: ".length).trim();
  const blockingIssues = remaining[2].slice("- Blocking issues: ".length).trim();
  const hasRepositoryGate = /(?:^|[\s,，])repository-gate(?:$|[\s,，])/.test(
    requiredGates,
  );
  const hasValidBlockers =
    blockingIssues === "none" ||
    /^#[1-9][0-9]*(?:[ \t]*,[ \t]*#[1-9][0-9]*)*$/.test(blockingIssues);
  if (
    deliveryType !== "code" ||
    !["yes", "no"].includes(contractChange) ||
    !hasRepositoryGate ||
    !hasValidBlockers
  ) {
    return undefined;
  }
  return { repositories };
};

const parseCounterpart = (line: string): Counterpart | undefined => {
  const prefix = "- Counterpart: ";
  if (!line.startsWith(prefix)) return undefined;
  const parts = line.slice(prefix.length).split(" | ");
  if (parts.length !== 4) return undefined;
  const [repository, branchPart, pullRequestPart, shaPart] = parts;
  if (
    repository === undefined ||
    branchPart === undefined ||
    pullRequestPart === undefined ||
    shaPart === undefined ||
    !repositoryPattern.test(repository) ||
    !branchPart.startsWith("branch=") ||
    !pullRequestPart.startsWith("pr=") ||
    !shaPart.startsWith("sha=")
  ) {
    return undefined;
  }

  const branch = branchPart.slice("branch=".length);
  const pullRequestUrl = pullRequestPart.slice("pr=".length);
  const sha = shaPart.slice("sha=".length);
  const pullRequestMatch = pullRequestUrlPattern.exec(pullRequestUrl);
  if (
    !branchPattern.test(branch) ||
    pullRequestMatch?.groups?.repository !== repository ||
    !shaPattern.test(sha)
  ) {
    return undefined;
  }
  return { repository, branch, pullRequestUrl, sha };
};

const parseCrossRepositoryDelivery = (
  body: string,
): { present: boolean; delivery?: CrossRepositoryDelivery } => {
  const section = sectionLines(body, "Cross-repository delivery");
  const lines = section.lines;
  if (!section.present) return { present: false };
  if (lines.length < 4 || !lines[0]?.startsWith("- Delivery state: ")) {
    return { present: true };
  }

  const state = lines[0].slice("- Delivery state: ".length).trim();
  let counterpartEnd = 1;
  const counterparts: Counterpart[] = [];
  while (lines[counterpartEnd]?.startsWith("- Counterpart: ")) {
    const counterpart = parseCounterpart(lines[counterpartEnd]!);
    if (counterpart === undefined) return { present: true };
    counterparts.push(counterpart);
    counterpartEnd += 1;
  }

  const remaining = lines.slice(counterpartEnd);
  if (
    counterparts.length === 0 ||
    remaining.length !== 2 ||
    !remaining[0]?.startsWith("- Merge blockers: ") ||
    !remaining[1]?.startsWith("- Candidate preflight: ")
  ) {
    return { present: true };
  }

  const blockersValue = remaining[0].slice("- Merge blockers: ".length).trim();
  const mergeBlockers = blockersValue === "none" ? [] : blockersValue.split(/,[ \t]*/);
  if (mergeBlockers.some((url) => !pullRequestUrlPattern.test(url))) {
    return { present: true };
  }
  const candidatePreflight = remaining[1].slice("- Candidate preflight: ".length).trim();
  if (candidatePreflight !== "pending" && !actionsRunPattern.test(candidatePreflight)) {
    return { present: true };
  }
  return {
    present: true,
    delivery: { state, counterparts, mergeBlockers, candidatePreflight },
  };
};

export const validatePullRequest = (metadata: PullRequestMetadata): string[] => {
  const errors: string[] = [];
  if (metadata.baseRef !== "main") errors.push("PR 必须以 main 为目标分支");

  const branchMatch = branchPattern.exec(metadata.headRef);
  if (branchMatch === null) errors.push("分支名必须符合 codex/issue-<number>-<slug>");

  const issueReferences = [...metadata.body.matchAll(issueReferencePattern)].map(
    (match) => match.groups?.issue,
  );
  if (issueReferences.length !== 1) {
    errors.push("PR 必须且只能包含一行 Issue 引用");
  } else if (branchMatch?.groups?.issue !== issueReferences[0]) {
    errors.push("PR 引用的 Issue 必须与分支中的 Issue 编号一致");
  }
  if (closingKeywordPattern.test(metadata.body)) {
    errors.push("PR 不得使用自动关闭 Issue 的关键字");
  }

  const scope = parseDeliveryScope(metadata.body);
  if (scope === undefined) {
    errors.push("PR 必须填写完整且有效的 Delivery scope");
  } else if (!scope.repositories.includes(CURRENT_REPOSITORY)) {
    errors.push(`Delivery scope 必须列出 ${CURRENT_REPOSITORY}`);
  }

  const cross = parseCrossRepositoryDelivery(metadata.body);
  if (scope !== undefined && scope.repositories.length > 1) {
    if (!cross.present || cross.delivery === undefined) {
      errors.push("跨仓 PR 必须填写完整且有效的 Cross-repository delivery");
    } else {
      const delivery = cross.delivery;
      const expectedRepositories = new Set(
        scope.repositories.filter((repository) => repository !== CURRENT_REPOSITORY),
      );
      const counterpartRepositories = delivery.counterparts.map(
        (counterpart) => counterpart.repository,
      );
      if (
        new Set(counterpartRepositories).size !== counterpartRepositories.length ||
        counterpartRepositories.some(
          (repository) => !expectedRepositories.has(repository),
        ) ||
        counterpartRepositories.length !== expectedRepositories.size
      ) {
        errors.push("Counterpart 必须逐一覆盖 Delivery scope 中的其他仓库");
      }
      if (
        delivery.counterparts.some(
          (counterpart) => counterpart.branch !== metadata.headRef,
        )
      ) {
        errors.push("消费者 PR 的 Counterpart 必须使用同名 Issue 分支");
      }
      const counterpartUrls = new Set(
        delivery.counterparts.map((counterpart) => counterpart.pullRequestUrl),
      );
      if (delivery.mergeBlockers.some((blocker) => !counterpartUrls.has(blocker))) {
        errors.push("Merge blockers 必须引用已声明的 Counterpart PR");
      }
      if (!["blocked", "ready"].includes(delivery.state)) {
        errors.push("Delivery state 必须是 blocked 或 ready");
      }
      if (delivery.state === "blocked" && delivery.mergeBlockers.length === 0) {
        errors.push("blocked 状态必须声明至少一个 Merge blocker");
      }
      if (delivery.state === "ready" && delivery.mergeBlockers.length > 0) {
        errors.push("ready 状态必须使用 Merge blockers: none");
      }
      if (delivery.state === "ready" && delivery.candidatePreflight === "pending") {
        errors.push("ready 状态必须记录成功的 Candidate preflight URL");
      }
      if (
        !metadata.isDraft &&
        (delivery.state !== "ready" ||
          delivery.mergeBlockers.length > 0 ||
          delivery.candidatePreflight === "pending")
      ) {
        errors.push("非 Draft 跨仓 PR 必须 ready、无 blocker 且具有预检 URL");
      }
    }
  } else if (cross.present) {
    errors.push("单仓 PR 不得声明 Cross-repository delivery");
  }
  return errors;
};

const main = (): number => {
  const draftValue = process.env.PR_IS_DRAFT;
  const errors =
    draftValue === "true" || draftValue === "false"
      ? validatePullRequest({
          baseRef: process.env.PR_BASE_REF ?? "",
          headRef: process.env.PR_HEAD_REF ?? "",
          body: process.env.PR_BODY ?? "",
          isDraft: draftValue === "true",
        })
      : ["PR_IS_DRAFT 必须明确为 true 或 false"];
  for (const error of errors) console.error(`::error::${error}`);
  return errors.length === 0 ? 0 : 1;
};

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(invokedPath).href) {
  process.exitCode = main();
}
