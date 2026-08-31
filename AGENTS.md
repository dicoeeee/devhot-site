# Codex workspace instructions

本仓库是 Devhot 的公开静态网站构建与部署仓库。以下规则适用于所有 Phase，以及代码、文档、测试、CI、部署脚本和配置变更。

## Issue 与交付范围

- 项目唯一 Issue tracker 是 `dicoeeee/devhot`。开发前使用
  `gh issue view --repo dicoeeee/devhot <number> --comments`
  读取完整 Issue、`Delivery scope`、依赖和评论。
- 只有 Issue 的 `Repositories` 明确列出 `dicoeeee/devhot-site`
  时，才允许修改本仓库。发现需要增加仓库或改变契约时，先更新 Issue 并取得用户确认，不得直接扩大范围。
- 一个仓库由一个独立 Session、分支和 PR 交付。跨仓任务不得通过本地目录拼接伪装为单仓交付。
- 跨仓 Issue 的开发与候选预检可以并行；所有仓库都必须先有独立 Draft
  PR，再使用完整候选 SHA 运行 `dicoeeee/devhot` 中的
  `cross-repository-preflight`。正式合入仍按消费者优先，本仓作为消费者先合入。

## 一票一分支、一仓一 PR

- 每个代码类 Issue 都从最新 `origin/main` 创建全新分支，名称为
  `codex/issue-<number>-<slug>`。
- 禁止在 `main`
  开发、提交或直接推送；禁止从其他 Issue 分支开始新工作、多个 Issue 共用分支或复用已合并分支。
- 已合并后仍需补充时，创建 `codex/issue-<number>-<slug>-followup-1`，后续递增编号。
- 一个 PR 只交付一个主要 Issue，目标分支必须是 `main`，正文使用
  `Refs dicoeeee/devhot#<number>`；不得使用 `Closes`、`Fixes` 或其他自动关闭关键字。
- 实现 Agent 不得自行合并 PR 或关闭 Issue，未经用户明确授权不得评论 Issue。代码完成、分支推送、PR 创建、PR
  CI 通过、PR 合入、合入后 `main` gate 通过且用户明确授权后，Issue 才具备关闭资格。

## 本仓门禁

本地和 CI 使用同一入口，Node.js 必须是 `24.19.0`：

```sh
npm ci
npm run gate
```

- 提交前完成与 Issue 对应的测试和双轴 code review，并在 PR 中记录结果。
- `repository-gate` 保护普通代码 PR；`publication-gate`
  只保护自动网站输入候选，两者不能互相替代。
- 任一必需检查失败、取消、未运行或被跳过时，不得合并或把 Issue 报告为完成。
- 跨仓 PR 必须填写机器可读的 `Cross-repository delivery`。Draft 可以保持
  `blocked`/`pending`；离开 Draft 前必须为
  `ready`、`Merge blockers: none`，并记录成功的候选预检 Actions run URL。缺 counterpart
  PR、同名 Issue 分支、40 位 SHA 或仓库范围不一致时门禁失败；本仓作为消费者时不接受 producer
  counterpart 提前指向 `main`。
- 离开 Draft 前先在 Draft 状态完成上述元数据更新，并等待 `edited` 事件的稳定 PR gate
  `npm run gate` 通过；标记 Ready 后再等待 `ready_for_review`
  事件的同名检查通过。当前人工补偿控制中，用户负责检视精确 SHA 并明确授权本次合入，Codex 负责重新核对元数据与门禁后触发 merge；GitHub 显示
  `mergeable` 或 `CLEAN` 不能替代这些检查。

## 公开与凭据边界

- 本仓库不得包含 Devhot 私有源码、SQLite、运行时归档、日志、提示词、凭据、浏览器会话、GitHub
  App 私钥或未确认内容。
- 普通代码变更必须走 Issue 分支和 PR。自动内容发布只允许
  `publication/** → publication-gate → 同一候选 SHA fast-forward main`，且只能修改
  `site-input/**`。
- 自动内容发布不得修改代码、Schema、依赖、工作流、配置或部署工具；需要这些改动时必须创建新的代码 Issue、分支和 PR。

## Issue 关闭边界

- 单仓代码 Issue 必须记录本仓 PR、merge SHA 和合入后 `main` CI URL。
- 跨仓代码 Issue 必须等待所有列出的仓库分别完成分支、PR、合入和合入后 CI，并通过精确 SHA 的跨仓兼容测试。
- 本地提交、远端功能分支、尚未合入的 PR 或被跳过的测试都不是完成证据。
