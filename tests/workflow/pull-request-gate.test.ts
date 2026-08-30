import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { validatePullRequest } from "../../tools/validate-pull-request";

const branch = "codex/issue-91-cross-repository-governance";
const devhotPr = "https://github.com/dicoeeee/devhot/pull/92";
const preflight = "https://github.com/dicoeeee/devhot/actions/runs/123456";
const devhotSha = "a".repeat(40);
const singleRepositoryBody = `Refs dicoeeee/devhot#91

## Delivery scope

- Delivery type: code
- Repositories:
  - dicoeeee/devhot-site
- Contract change: no
- Required gates: repository-gate
- Blocking issues: none
`;
const crossRepositoryBody = `Refs dicoeeee/devhot#91

## Delivery scope

- Delivery type: code
- Repositories:
  - dicoeeee/devhot
  - dicoeeee/devhot-site
- Contract change: yes
- Required gates: repository-gate, cross-repository-preflight
- Blocking issues: none

## Cross-repository delivery

- Delivery state: blocked
- Counterpart: dicoeeee/devhot | branch=${branch} | pr=${devhotPr} | sha=${devhotSha}
- Merge blockers: ${devhotPr}
- Candidate preflight: pending
`;

describe("repository pull request metadata gate", () => {
  it("keeps single-repository delivery backward compatible", () => {
    expect(
      validatePullRequest({
        baseRef: "main",
        headRef: branch,
        body: singleRepositoryBody,
        isDraft: false,
      }),
    ).toEqual([]);
  });

  it("accepts a blocked Draft with one exact counterpart SHA", () => {
    expect(
      validatePullRequest({
        baseRef: "main",
        headRef: branch,
        body: crossRepositoryBody,
        isDraft: true,
      }),
    ).toEqual([]);
  });

  it("accepts a non-Draft only when ready, unblocked, and preflighted", () => {
    const body = crossRepositoryBody
      .replace("Delivery state: blocked", "Delivery state: ready")
      .replace(`Merge blockers: ${devhotPr}`, "Merge blockers: none")
      .replace("Candidate preflight: pending", `Candidate preflight: ${preflight}`);

    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: false }),
    ).toEqual([]);
  });

  it("rejects a producer counterpart on main before the consumer is merged", () => {
    const body = crossRepositoryBody.replace(`branch=${branch}`, "branch=main");

    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: true }),
    ).toContain("跨仓 PR 必须填写完整且有效的 Cross-repository delivery");
  });

  it.each([
    ["missing counterpart", crossRepositoryBody.replace(/^- Counterpart:.*\n/m, "")],
    ["missing sha", crossRepositoryBody.replace(devhotSha, "pending")],
    ["short sha", crossRepositoryBody.replace(devhotSha, "a".repeat(39))],
  ])("rejects %s", (_name, body) => {
    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: true }),
    ).toContain("跨仓 PR 必须填写完整且有效的 Cross-repository delivery");
  });

  it("rejects counterpart repositories outside Delivery scope", () => {
    const body = crossRepositoryBody.replace(
      "  - dicoeeee/devhot\n",
      "  - dicoeeee/future-service\n",
    );

    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: true }),
    ).toContain("Counterpart 必须逐一覆盖 Delivery scope 中的其他仓库");
  });

  it("rejects ready plus pending", () => {
    const body = crossRepositoryBody
      .replace("Delivery state: blocked", "Delivery state: ready")
      .replace(`Merge blockers: ${devhotPr}`, "Merge blockers: none");

    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: true }),
    ).toContain("ready 状态必须记录成功的 Candidate preflight URL");
  });

  it("rejects blocked plus none", () => {
    const body = crossRepositoryBody.replace(
      `Merge blockers: ${devhotPr}`,
      "Merge blockers: none",
    );

    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: true }),
    ).toContain("blocked 状态必须声明至少一个 Merge blocker");
  });

  it("rejects leaving Draft while blocked", () => {
    const body = crossRepositoryBody.replace(
      "Candidate preflight: pending",
      `Candidate preflight: ${preflight}`,
    );

    expect(
      validatePullRequest({ baseRef: "main", headRef: branch, body, isDraft: false }),
    ).toContain("非 Draft 跨仓 PR 必须 ready、无 blocker 且具有预检 URL");
  });

  it("rejects a non-main target, branch mismatch, and closing keyword", () => {
    const errors = validatePullRequest({
      baseRef: "release",
      headRef: "codex/issue-92-unrelated",
      body: `${singleRepositoryBody}\nCloses dicoeeee/devhot#91\n`,
      isDraft: false,
    });

    expect(errors).toContain("PR 必须以 main 为目标分支");
    expect(errors).toContain("PR 引用的 Issue 必须与分支中的 Issue 编号一致");
    expect(errors).toContain("PR 不得使用自动关闭 Issue 的关键字");
  });

  it("runs metadata validation for PR lifecycle events before the repository gate", async () => {
    const workflow = await readFile(
      join(process.cwd(), ".github", "workflows", "repository-gate.yml"),
      "utf8",
    );

    expect(workflow).toContain("- edited");
    expect(workflow).toContain("- ready_for_review");
    expect(workflow).toContain("- converted_to_draft");
    expect(workflow).toContain("jobs:\n  gate:\n    name: npm run gate");
    expect(workflow).toContain("PR_IS_DRAFT:");
    expect(workflow).toContain("npx tsx tools/validate-pull-request.ts");
    expect(workflow.indexOf("Validate pull request metadata")).toBeLessThan(
      workflow.indexOf("Run the single repository gate"),
    );
  });
});
