# devhot-site

`devhot-site`
是 DEVHOT 的公开静态网站构建仓库。当前切片从一份受控、版本化的 fixture 出发，经输入验证、只读内容端口和唯一 composition
root，生成首页、当前洞察详情与独立来源归档。

## 当前边界

- 仓库只有一个 npm package、一个 `package-lock.json`，不使用 workspaces。
- Astro 保持静态输出；没有 SSR、API、数据库、模型调用或运行时数据请求。
- 页面只通过 `SiteContentRepository` 获取稳定对象，不直接读取
  `site-input/`、Manifest或文件系统。
- `site-input/manifest.json` 完整枚举结构数据和内容寻址资源；未声明文件会使构建失败。
- 当前 fixture 生成 `/software-engineering/`、一条 `/insights/<id>/` 和对应
  `/sources/<id>/`；两类内容页使用双向稳定链接，仍不代表七类正式读者页面已经全部实施。
- 仓库不包含 Devhot SQLite、日志、凭据、私有运行状态或未经确认的内容。

## 唯一门禁

需要 Node.js `24.19.0`：

```sh
npm ci
npm run gate
```

`npm run gate`
依次执行输入验证、格式和严格类型检查、依赖方向检查、测试、完整静态构建、Manifest 白名单资源复制及
`dist` 验证。任一步失败都会使门禁失败。

`npm run build` 复用同一输入与输出验证链，但不替代完整门禁。

## 输入与内容边界

```text
site-input/manifest.json (v2, baseline SHA + input identity)
        ↓ schema / 文件集合 / 模式 / SHA-256 / 引用验证
VerifiedPublicationInput
        ↓ PublicationInputRepository
SiteContentRepository
        ↓ 唯一 composition root
Astro pages → dist/ → output verifier
```

`contracts/` 保存语言无关的 JSON Schema；`src/content/model/` 与 `src/content/ports/`
不依赖物理输入布局；`src/content/adapters/publication-input/`
是当前唯一静态适配器。Manifest 只允许引用已声明并校验 SHA-256 的文件；未知文件、悬空引用和没有任何公开对象引用的资源都会使门禁失败。来源缺少可靠发布时间时保留
`first_collected_at`，页面显示“抓取于”，不会改写为发布时间。

## 固定构建运行时

- Node.js：`24.19.0`，官方发布于 2026-08-03。
- 官方构建镜像：`node:24.19.0-alpine3.24`。
- OCI multi-platform digest：
  `sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43`。
- Docker Hub 在 2026-08-19 回读的支持架构：`linux/amd64`、`linux/arm64/v8`、
  `linux/s390x`。

`Dockerfile` 同时固定可读 tag 和 digest，并在镜像构建中执行 `npm ci` 与
`npm run gate`。GitHub Actions 使用同一精确 Node 版本和唯一门禁。

Rolldown 1.2.5 先前缺失的 `darwin-x64` 与 `linux-arm64-gnu` optional
binding 已发布，`package-lock.json` 固定其完整版本、下载地址和完整性哈希。不得恢复只有
`optional: true` 而没有版本的惰性占位；npm
11.17.0 会在干净安装的依赖去重阶段把空版本交给 SemVer，并以 `Invalid Version` 失败。

## 品牌资产

`site-input/assets/sha256/73bc08f1…110c89.png`
是 Devhot 受控透明 CIMC 原始标志的逐字节副本，SHA-256 为
`73bc08f1a558271ed021a4f51fcc4a07d2850deea7cb592282ae0f9d5a110c89`。构建只按原长宽比显示，不重绘、不改色、不裁切、不拉伸。
