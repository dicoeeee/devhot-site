Refs dicoeeee/devhot#<number>

跨仓 Issue 为 Delivery scope 中每个其他仓库保留一条 `Counterpart`；单仓 Issue 删除整个
`Cross-repository delivery` 区段。

## Delivery scope

- Delivery type: code
- Repositories:
  - dicoeeee/devhot-site
- Contract change: yes | no
- Required gates: repository-gate
- Blocking issues: none | #<number>

## Cross-repository delivery

- Delivery state: blocked | ready
- Counterpart: <repository> | branch=<branch> | pr=<URL> | sha=<40-hex>
- Merge blockers: <PR URL> | none
- Candidate preflight: <Actions run URL> | pending

## Verification

- [ ] 当前 Issue 的 `Repositories` 明确包含 `dicoeeee/devhot-site`。
- [ ] 本分支从最新 `origin/main` 全新创建，且只交付一个主要 Issue。
- [ ] `npm ci`
- [ ] `npm run gate`
- [ ] Standards code review 无未解决阻断项。
- [ ] Spec code review 无未解决阻断项。
- [ ] 跨仓 Draft PR 均已存在，候选预检使用完整远端 SHA 且没有 skip。
- [ ] 离开 Draft 前已更新为 `ready`、`Merge blockers: none` 和最终成功预检 URL。
- [ ] `edited` 事件的 `npm run gate` 已通过。
- [ ] `ready_for_review` 事件的 `npm run gate` 已通过。
- [ ] 用户已检视当前精确 SHA，并明确授权 Codex 执行本次合入。

## Delivery evidence

- Branch:
- Head SHA:
- PR URL:
- Contract change: yes / no
- Related repository SHA, if any:
- Candidate preflight URL, if any:
- PR gate URL:
- Stable PR gate context: `npm run gate`
- `edited` gate URL:
- `ready_for_review` gate URL:
- User-reviewed exact SHA:
- Merge authorization:
- Manual-control residual risk: no server-side Required Check; Actions provide detection
  evidence only.
- Merge SHA, after merge:
- Main gate URL, after merge:

## Merge and closure

- [ ] 我不会直接推送 `main`，也不会由实现 Agent 自行合并本 PR。
- [ ] 我不会通过本 PR 自动关闭 Issue。
- [ ] 只有所有仓库 PR 合入、合入后的 `main`
      gate 成功、远端证据记录完成且用户明确授权后，Issue 才能关闭。
