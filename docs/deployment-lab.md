# 本地多容器升级实验室（Issue #82）

本票仅修改 `dicoeeee/devhot-site`，开发起点为
`origin/main@8670e60a10b5873dcc1db69d5bc65e58926dc43c`。前置 #70、#78 已关闭。真实 GitHub
App/Ruleset 属于 #81；失败恢复状态机属于 #83；Rootless 主机包与真实 LAN 验收分别属于 #84、#85。

## 运行与证据

使用 Node `24.19.0`、Python `3.9+` 和已经可用的本地 Linux Docker daemon：

```sh
npm ci
npm run gate
npm run deployment:lab -- --context <本地Docker上下文> --output <不存在的证据目录>
```

不传 `--context` 时使用 Docker 当前上下文，但拒绝 TCP/SSH 远端 daemon。`--preflight`
单独检查运行时与架构；完整命令还实际验证镜像、隔离网络、原生卷、只读子目录挂载和原子链接。需要 Docker 的
`volume-subpath`
能力；不具备该能力即失败，不安装运行时、不切换全局上下文，也不修改主机网络配置。

默认输出位于 Git 忽略的
`.cache/deployment-lab/<唯一ID>/`；自定义输出应在源码目录之外。已存在的输出不会被覆盖。`report.json`
包含阶段、状态、固定错误码和实际 SHA；`logs/`
保留构建及失败诊断。退出码零只表示全部实验阶段和本次资源清理成功。失败保留
`failure_phase`，不会被最后的 cleanup 阶段掩盖。

每次运行使用唯一标签，只移除标签和名称都属于该次运行的容器、网络、卷及临时浏览器客户端镜像。保留上游固定镜像缓存和本次报告，不清理其他容器或历史实验目录。外部强制终止/daemon 消失可能留下本次资源，报告会保持失败或未完成状态，应按运行 ID 检查资源后再执行新的实验。

## 验收映射（实施前建立，最终证据写入 PR 与 Issue）

| 条件                              | 实现位置                             | 正向/负向验证                                                                                   | 实际证据位置                                                        |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| AC1 运行时、架构、网络/卷能力     | `lab.py` preflight、volume_preflight | 实际 Docker info、只读卷与原子链接；缺运行时、远端 daemon、非法输出明确失败                     | report 的 preflight、networks、volume_preflight；Python 命令负例    |
| AC2 固定 Node/Nginx digest、arm64 | `lab_docker.py` image                | 实际镜像 digest、平台、Node 与 Nginx 版本；任意覆盖值或错误平台拒绝                             | images 节点与两个 build 日志                                        |
| AC3 真实容器与隔离网络            | `lab.py`、`lab_docker.py`            | 构建网络与 internal 服务网络隔离；逐个检查容器挂载与身份                                        | networks、build_v1/v2、nginx_started、isolation                     |
| AC4 干净安装、完整 gate、构建边界 | `lab.py` builder                     | 两版本各执行 npm ci、完整 npm run gate、产物校验；只有公开源码只读挂载                          | build-v1.log、build-v2.log、build 节点                              |
| AC5 非特权只读 Nginx 8080         | `lab.py` nginx                       | 原样挂载既有两个配置、nginx -t；UID 101、只读写入失败、无宿主端口                               | nginx-check.log、nginx_started 与实际 HTTP                          |
| AC6 v1 七类页面稳定 HTTP          | `lab-client.cjs`                     | 真实浏览器访问全部元数据路由、七类页面；版本、资源哈希、响应头                                  | http_v1 的 SHA、路径、ETag、资源结果                                |
| AC7 v2 原子切换、Nginx 不重启     | `release_store.py`、`lab_storage.py` | 同文件系统 rename/replace；并发文件读取只见完整版本；稳定入口从 v1 到 v2，旧 ETag 不掩盖新 HTML | activate_v1/v2、http_v1/v2、isolation 中相同容器 ID/StartedAt       |
| AC8 断网仍完整可读                | internal 服务网络、持久浏览器        | 各页面/资源成功；浏览器无第三方请求或资源失败；直连外网 TCP 被阻断                              | http_v1/v2 的 external_requests、failed_resources、external_network |
| AC9 未批准客户端隔离              | 独立 outsider 容器                   | 未连接服务网络的客户端无法连接站点 IP:8080；批准客户端正常                                      | isolation 的 unapproved_client=blocked                              |
| AC10 一个公开命令重复运行         | `npm run deployment:lab`             | 实际完整运行、阶段报告、清理；负例非零退出，不 skip                                             | report 最终 status 与 cleanup；CI 完整日志                          |

## 存储与输入边界

实验版本在临时 Git 仓库中形成：快照只读取已经纳入 Git 索引的公开文件，再构造两个有效网站输入版本并取得各自完整 Git
SHA。未跟踪文件不会被读取或带入构建。提交前验证新增文件时，先对确认属于本票的具体路径执行
`git add --intent-to-add <路径>`；这只登记文件，不创建 commit，也不允许批量纳入无关文件。构建使用独立只读源码导出和显式
`DEVHOT_SITE_BUILD_SHA`，不读取 Devhot 私有内容，不向网站 main 发布内容。

候选与版本提升在同一个 Docker
Linux 原生卷内完成，避免 macOS 共享文件系统的符号链接缓存干扰原子切换。专用存储辅助容器执行同一份
`release_store.py`；它只写本次卷，没有 Docker
socket，也不能联网。经过完整 gate 与产物校验的文件通过所有权明确的归档进入候选目录，再次校验后才提升。

Nginx 通过 `volume-subpath=releases`
只读取得发布子目录，无法访问同卷的候选目录。卷中的固定 `html -> current` 链接使既有配置的
`/usr/share/nginx/html` 根目录解析到
`current -> versions/<sha>`；整个 releases 父目录被挂载，切换不会替换挂载对象。`nginx-serving.conf`
和 `security-headers.conf` 原样挂载，不另行覆盖安全头或缓存指令。

构建容器只读取公开源码，在自身文件系统执行干净安装与完整 gate；没有候选卷、状态、其他版本、current 或 Docker
socket。持久浏览器客户端从首个通过 gate 的构建容器取得锁定的浏览器及依赖，清空构建代理变量，在只读文件系统和 internal 网络中访问稳定 Nginx。该临时客户端镜像不发布、不作为网站部署身份，并在实验结束时删除。

## 治理与真实环境边界

`npm run gate` 不递归运行 Docker 实验室。CI 的独立 deployment-lab
Job 在 runner 上运行同一公开命令，每个构建容器内部仍执行完整 gate。缺运行时、构建失败、浏览器失败或清理失败均不得转为 skip/成功。

本机首次直连 Docker Hub 不可用时，可以使用 Docker 官方 ECR 分发路径取得**完全相同的 Node
digest**，具体环境变量见 README；不允许更换版本或任意镜像。构建代理只支持无账号密码的 HTTP(S) 地址，不传递到 Nginx 或浏览器运行阶段。该能力不改变公开源和凭据边界。

macOS Colima 与 CI runner 的实验不证明真实 Linux Rootless、LAN
IP:80、防火墙、服务账号或重启恢复。这里不安装系统级容器运行时、不修改主机 capability、防火墙、真实 GitHub
App/Ruleset、部署或调度。提交前两轮独立审核、远端精确 head PR 复审、事件门禁、合入后 main
CI 和 Issue 验收仍分别记录。

显式使用构建代理时，只在临时构建容器内关闭 APT HTTP
pipelining，并将包文件下载设置为最多两次重试、单次连接/数据等待 30 秒。这采用
[Debian APT 传输选项](https://manpages.debian.org/bookworm/apt/apt-transport-http.1.en.html)
与
[Acquire::Retries](https://manpages.debian.org/bookworm/apt/apt.conf.5.en.html)，用于处理代理批量下载中断；不放宽签名校验、不重试确定性输入/构建错误、不修改宿主配置。持续下载失败仍使整个实验失败。

默认 Debian CDN 路径不可用时，维护者可显式设置 `DEVHOT_LAB_DEBIAN_MIRROR=ustc`。
`lab_apt.py` 只接受这一枚举，将固定镜像的两条默认仓库 URI 改为
`https://mirrors.ustc.edu.cn/debian` 与
`https://mirrors.ustc.edu.cn/debian-security`。该站点列于
[Debian 官方镜像列表](https://www.debian.org/mirror/list)，中国镜像别名亦指向它。变更只发生在临时构建容器，报告记录所选镜像；发行版、组件、`Signed-By`、APT 签名及包哈希校验均保留。未知选项、非预期原始源明确失败，默认行为不变。真实文件回归测试检查改写结果、签名字段保留和拒绝后原文件不变；完整实验验证实际安装与两个版本的门禁，不以镜像探测成功替代构建成功。

并发读取的严格断言在 Linux 原生部署卷内执行：预检重复 16 次真实
`ReleaseStore.activate`，并发线程必须同时观察到完整 v1 与 v2，读取错误必须为零，旧版本必须保留。该项是完整实验的强制阶段，结果记录在
`volume_preflight.concurrent_reads`，任何错误都使实验失败。跨平台 `npm run gate`
保留顺序切换、不可变版本和所有负向边界测试；它不把 macOS 对并发符号链接读取的语义当作 Linux 部署文件系统证据。本机已观测到 macOS 该路径的间歇性
`EINVAL`，相关失败如实保留，不通过忽略异常或 skip 取得成功。
