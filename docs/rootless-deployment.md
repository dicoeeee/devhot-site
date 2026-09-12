# Rootless Linux 部署包（Issue #84）

本票仅修改 `dicoeeee/devhot-site`，基线为
`1a5d10d13c9ed33620adce4834f236469bb6bf24`。复用 #83 的部署状态机，不改变网站输入契约。真实 GitHub 治理和真实局域网主机验收分别由 #81、#85 交付。

## 实施前验收映射

测试接缝沿用 #68 Testing
Decisions 与 #84 已批准范围：公开部署命令、主机只读检查、生成的部署配置、Git/文件/HTTP 结果，以及既有真实多容器实验。系统环境替身只能提供受控主机事实或注入故障；不能把它们称作真实 Rootless 主机验收。

| 条件                            | 实现位置与责任          | 正向及负向测试                                                                           | 实际证据                                   |
| ------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------ |
| AC1 专用非登录、无 sudo 账号    | 主机检查、安装材料      | 正确账号；root、登录 shell、管理组、sudo 可用、目录权限越界拒绝                          | 命令检查结果、主机事实测试；真实主机留 #85 |
| AC2 Rootless 前置条件           | 主机检查                | subordinate ID、映射工具、namespace、cgroup v2/systemd、Unix socket；缺失或 rootful 拒绝 | 检查正负输出、实际本机只读负例             |
| AC3 RootlessKit 最小 capability | 配置身份与主机检查      | 固定规范路径、root 所有权、不可写、SHA/文件身份、实际进程；缺失或扩大 capability 拒绝    | 身份正负测试；真实 capability 授权留 #85   |
| AC4 指定 LAN IP:80 到 8080      | 配置与 Compose          | 明确地址；通配、非 LAN、额外端口、root Nginx 拒绝                                        | 生成配置、Compose 解析、容器回归           |
| AC5 固定镜像                    | 共用镜像身份与运维步骤  | 精确版本/digest/架构；漂移拒绝                                                           | 真实镜像检查与多容器报告                   |
| AC6 挂载隔离                    | 构建及服务配置          | source 只读、候选隔离；Docker socket/状态/current/其他版本不可达                         | 配置正负测试、真实容器隔离                 |
| AC7 timer 默认禁用              | 用户级 unit 与安装材料  | Asia/Shanghai 02:00、Persistent、非重叠；无 enable/start 副作用                          | systemd 语法验证、安装产物和状态测试       |
| AC8 journald 与公开 JSON        | 命令事件、既有状态投影  | 固定阶段/结果/SHA/耗时；无正文、配置或异常转储                                           | 事件与公开投影测试、既有真实 HTTP          |
| AC9 部署/状态/重试/回滚         | 命令适配器与 #83 控制器 | real Git 获取、完整构建、同锁覆盖 ref 查询；失败/暂停与恢复                              | 临时 bare Git、实际文件/HTTP、完整容器回归 |
| AC10 无管理员写入检查           | check 命令、文档        | 只读成功/失败，不修复系统、不启用 timer                                                  | 检查前后状态；明确未验证的 #85 差异        |

实际通过结果、独立审核版本及远端 CI 链接将在 PR 与 Issue 记录；本表不是预先通过声明。

## 配置与检查模式

入口为 `python3 -E -s -B deploy/host.py`。生产运行必须使用安装到 `/opt/devhot-site`
的已审核版本。 `deploy/instance.example.json`
故意使用不能通过校验的占位值；管理员填入获准的 UID/GID、RFC1918 LAN
IPv4、客户端网段及 RootlessKit 身份后，将真实配置仅保存在主机
`/etc/devhot-site/instance.json`，权限 `root:devhot-site 0640`，父目录
`root:devhot-site 0750`。不支持凭据、Docker
context、远端 URL、浮动镜像或任意命令字段。首版只发布 IPv4；IPv6 不发布，实际拒绝 IPv6 访问仍在 #85 验收。

`render` 可以读取尚未安装的配置，但只新建一个私有材料目录，不连接 Docker：

```sh
python3 -E -s -B deploy/host.py --config /path/to/local-instance.json render --output /path/to/new-package
```

以专用账号执行以下命令；`check` 不创建目录、锁、容器，不修改服务或 capability：

```sh
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py check
```

固定 `sudo -n -l` 只读否定查询完成后，立即设置并回读当前进程的
`PR_SET_NO_NEW_PRIVS=1`，此后才允许 Docker、Git 或部署操作。服务启动时不能预设 NNP，否则 sudo 的 setuid 策略查询本身无法执行。认证错误、NNP 限制或其他未知结果均拒绝，不算无 sudo 证明；部署进程和构建/Nginx 容器仍保持 NNP。

检查结果只输出固定条件码，不输出实例值、子进程原始输出、环境变量或错误堆栈。未知、不可读、权限不足均为失败，不降级到 rootful
Docker。检查涵盖账号、组、明确的 sudo 拒绝、rootful socket 不可访问、无冲突的 subordinate
IDs（整个集合逐条拒绝零/负/溢出、重叠和与专用身份相交的范围）、root 所有的 setuid 映射工具、实际 daemon 的 UID/GID
namespace 映射、cgroup v2/systemd 的 memory/pids 控制、Rootless daemon 和实际 Unix-only
API、RootlessKit 身份与唯一 capability、目录模式与同文件系统、空 Docker 客户端配置、指定 IP 和原样安装的 user
units。额外 unit drop-in 或用户覆盖也会拒绝。

Docker 观察使用明确的 `/run/user/<UID>/docker.sock` 和 root 创建的空目录
`/etc/devhot-site/docker-client`，不读取用户 Docker 配置、凭据或 context。RootlessKit 带文件 capability 时，内核通常拒绝非特权程序读取父进程
`/proc/PID/exe`。因此使用 root 所有的固定 user
unit、绝对启动脚本、净化后的 PATH/环境、systemd 有效配置，以及稳定 PID/starttime 和磁盘文件身份建立
`trusted_launch_chain` 证据；不把它称为直接读取运行中 exe
inode。遍历全部线程的子进程，核对 dockerd 的 namespace、描述符及实际监听 socket，不读取进程环境。固定 Docker
API 之外，只允许 dockerd 自有的 `/run/user/<UID>/docker/libnetwork/<12hex>.sock`
内部 IPC：Unix stream、专用 UID/GID、0600、受保护宿主父目录，并比对进程 mount
namespace 中同路径的 device/inode/权限身份。RootlessKit 的 `/run`
copy-up 链接只有在最终对象与已验证宿主 socket 完全一致时才能通过；未知端点或不可读状态仍拒绝。若主机安全策略阻止必要观察，检查报告缺口，由 #85 决定适用方案，不自动放宽策略。网络端点检查同时拒绝 daemon 的 IPv4/IPv6
TCP API。

## 管理员安装顺序（材料，不表示已经执行）

以下系统变更必须先取得目标主机管理员与用户授权。本票测试不执行这些动作。

1. 使用当前平台支持的 Rootless Docker 安装方法，创建固定名称 `devhot-site`
   的非登录账号，shell 使用 `/usr/sbin/nologin`、`/sbin/nologin` 或
   `/bin/false`；仅使用专用主组，不附加其他组，尤其不能加入
   `sudo`、`wheel`、`admin`、`docker`、`lxd`
   等管理组。账号不能访问私有 Devhot 数据或任何凭据。应安装 `sudo`
   并确认管理员在专用账号的 sudoers 配置中设置 `Defaults:devhot-site listpw=never`，用
   `visudo` 验证语法；该设置只允许无认证查询权限，不授予任何命令。再确认
   `LC_ALL=C sudo -n -l` 明确返回该账号不得运行 sudo（例如
   `Sorry, user devhot-site may not run sudo on HOST.`）。默认 listpw 可能先要求密码，因此密码、认证或 NNP 错误不能作为无 sudo 证明。安装脚本不写 sudoers。
2. 管理员分配互不冲突、每组至少 65536 个的
   `/etc/subuid`、`/etc/subgid`，安装 root 所有、模式 4755 的
   `/usr/bin/newuidmap`、`/usr/bin/newgidmap`，验证 RootlessKit 的 user
   namespace 与 cgroup v2/systemd。按主机发行版安装 `/usr/bin/docker`（含 Compose
   plugin）、`/usr/bin/systemctl`、`/usr/bin/systemd-cat`、`/usr/bin/unshare`、`/usr/sbin/ip`、`/usr/sbin/getcap`、Python
   3.9 或更高版本、Git。二进制和父目录必须由 root 所有且不可被普通用户写入。
3. 管理员审核 RootlessKit 的规范路径和升级来源，使用 `readlink -f`、`sha256sum`、`stat`
   记录路径、SHA-256、device、inode。只对该确认过的 root 所有普通可执行文件授予
   `cap_net_bind_service=ep`，用 `getcap`
   回读确认没有额外 capability。不得对 shell、dockerd、Nginx 授权，不修改全局
   `net.ipv4.ip_unprivileged_port_start`。升级后旧 SHA/device/inode 失配会阻止部署，须重新审核并更新本地配置；不会自动重新执行
   `setcap`。
4. 安装官方 `/usr/bin/dockerd-rootless.sh` 与 Rootless
   Docker 二进制，使用本包生成的 root 所有用户级 `docker.service`。该 unit 通过
   `/usr/bin/env -i`
   清除 user-manager 隐式环境，只传固定 HOME、PATH、runtime 和通知 socket，并明确指定唯一 Unix
   host 与 root 所有的空 daemon 配置。不能存在用户目录的 docker.service 覆盖、drop-in 或优先解析的
   `docker-rootlesskit`。需要管理员显式批准 linger 与 daemon 启动。非登录账号的 user-manager 进入方法参见 Docker 官方 troubleshooting。不能用系统级
   `User=devhot-site` 的 rootful 服务代替。通过受信执行链、稳定
   `MainPID`/starttime 和文件变更时间关联确认已固定的 RootlessKit，API 仅监听用户本地 Unix
   socket，socket 为专用 UID/GID、0600 或 0660。Docker daemon 不得暴露 TCP API。
5. 管理员准备以下目录。候选与 releases 必须同文件系统；runtime 每次开机由用户 manager 创建。账号 home/Rootless
   daemon 自有数据也必须私有，不能借用 Devhot 工作区。`/etc/devhot-site/docker-client`
   必须为空、root 所有且账号只读。发布、状态和 runtime 路径的所有祖先也必须由 root 或专用 UID 所有，且不能由组或其他用户写入；工具路径继续要求全链路 root 所有。

| 路径                                 | 所有者        | 模式 | 用途                       |
| ------------------------------------ | ------------- | ---- | -------------------------- |
| `/srv/devhot-site`                   | 专用 UID:GID  | 0750 | 发布根                     |
| `/srv/devhot-site/candidates`        | 专用 UID:GID  | 0700 | 未验证候选                 |
| `/srv/devhot-site/releases`          | 专用 UID:GID  | 0755 | Nginx 只读父目录           |
| `/srv/devhot-site/releases/versions` | 专用 UID:GID  | 0755 | 不可变版本                 |
| `/var/lib/devhot-site`               | 专用 UID:GID  | 0700 | 状态与本次准备工作         |
| `/var/lib/devhot-site/daemon-home`   | 专用 UID:GID  | 0700 | Rootless daemon 专用 HOME  |
| `/run/user/<UID>/devhot-site`        | 专用 UID:GID  | 0700 | 互斥锁与瞬态配置           |
| `/opt/devhot-site`                   | root:root     | 0755 | 已审核版本工具             |
| `/etc/devhot-site`                   | root:专用 GID | 0750 | 仅 VM 本地配置             |
| `/etc/devhot-site/docker-client`     | root:专用 GID | 0750 | 空的 Docker 客户端配置目录 |

6. 管理员从已合入、审核通过的精确代码 SHA 安装完整工具到
   `/opt/devhot-site`；root 所有，普通文件 0644、目录 0755，不允许符号链接或可写父目录。执行前确认工具来源，不以 root 执行用户可改写的 staging 脚本。将实例配置安装为上述 0640，并在管理员批准的防火墙上仅放行指定 LAN
   IPv4 与获准客户端网段的 TCP 80，拒绝其他接口/网段和 IPv6。绑定 LAN
   IP 本身不能代替防火墙验收。
7. 管理员运行安装检查；只有显式 `--apply`
   才写文件。首次安装要求目标不存在，不覆盖任何已有 unit、启用链接或实例 Compose；更新须另行审核。

```sh
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host_install.py
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host_install.py --apply
```

脚本仅安装
`/etc/systemd/user/docker.service`、`devhot-site.service`、`devhot-site.timer`，以及
`/etc/devhot-site/compose.json` 和空的
`daemon.json`。不创建账号，不安装二进制，不改 subordinate
IDs/capability/firewall/linger，不调用 daemon-reload、enable 或 start。站点 units 是用户级，`ConditionUser=devhot-site`
限定账号；安装后由管理员在该 user manager 执行 daemon-reload，再以专用账号运行
`host.py check` 并确认 timer
disabled/inactive。没有成功回读前不能把安装材料称为主机可运行证明。

8. 首次运行前准备该次开机的 runtime 目录，手动启动并验证站点。初始 Nginx 在首次成功部署前可以返回 404，首次构建失败不能报告上线。后续普通内容部署不重启、替换或停止 Nginx。

```sh
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py serve
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py check-main
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py status
```

`serve` 先重新核对 root 安装的 Compose 与代码约束一致，再以原样配置执行
`nginx -t`；显式使用空 env-file，不读取额外
`.env`。它不写固定名称的瞬态 Compose 文件，因此中断不会因该文件残留而永久阻止重试。已有容器必须匹配固定镜像、UID
101、cap-drop ALL、no-new-privileges、只读根、64 MiB
`/tmp`、三个只读挂载、独立普通 bridge 网络及唯一指定 LAN IP:80 →
8080；不匹配时拒绝并保留现状。

## 日常命令、失败与恢复

生产使用固定独立普通 bridge（`internal=false`），因为 Docker 不会为唯一 internal 网络生成宿主发布端口。唯一发布仍为明确 LAN
IPv4:80，不能用通配地址；真实客户端/防火墙检查属于 #85。普通 bridge 不表示网络层禁止出网，Nginx 配置与浏览器门禁继续禁止外部运行依赖；实验室保留 internal 网络验证断网自包含，并额外用固定镜像、临时 loopback 高端口测试普通 bridge
HTTP 可达及 internal 负例。loopback 实验不冒充真实 LAN 验收。

所有写入口使用同一非阻塞 OS 文件锁。锁在读取远端 ref/部署状态前取得，覆盖 Git 获取、完整构建、切换、入口复核、状态投影和清理；不能删除锁文件或杀死其他持锁者。定时竞争以
`deployment_busy` 跳过，人工命令返回失败。状态查询不创建或修复持久状态。

```sh
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py retry <完整40位失败或暂停SHA>
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py rollback <紧邻上一成功SHA>
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py recover
/usr/bin/python3 -E -s -B /opt/devhot-site/deploy/host.py cleanup
```

只从固定公开仓库匿名获取
`main`；指定重试 SHA 必须已记录为失败/暂停，且仍在已取得的 main 历史中。SHA 不变、失败 SHA、暂停 SHA 的普通检查不重复构建。远端查询、Git、镜像和锁定依赖准备共享整个调用最多三次尝试。临时准备失败保留站点，下次检查可以重试；确定性依赖或完整 gate 失败记录失败 SHA。

构建容器仅挂载精确 Git 树的只读 `/source`，不挂载 Docker
socket、状态、实例配置、current 或其他版本。容器内完整执行 `npm ci`、锁定浏览器安装和
`npm run gate`；完整构建成功后才复制 `dist`
到专用候选，验证 UID/GID、权限、输出清单和 SHA，再交给 #83 状态机原子切换。构建被中断时，遗留容器不能改写宿主发布指针；`recover`
在同锁内核对受管 builder 的身份并清理，再恢复核心状态。

稳定 LAN
HTTP 入口复核匹配 SHA、各页面字节和资产摘要；失败按 #83 协议回退并记录。不会移动 GitHub
main。只保留核心策略允许的版本，回滚不能选择任意历史 SHA。

部署事件的 stdout/stderr 只输出阶段、适用 SHA、结果、耗时和固定错误码。手动变更命令通过固定、root 所有的
`systemd-cat`
与已安装 worker 接入 journald；timer 已有的日志流则直接复用。入口验证 stdout/stderr 的实际 Unix
stream、固定 journal 端点和 root
peer，不使用环境标记冒充已接入。连接使用有界双向准入，worker 在父进程确认前不能进入部署；接流发生在 NNP 设置之前，完整主机检查仅由最终执行者运行。

初始日志连接失败时命令以固定错误返回，不执行部署。运行中写日志失败不会打断正在进行的切换补偿或原子回滚；操作安全结束后返回日志 I/O 错误码
`74`，不能将其解释为日志已保存或盲目重复发布。先通过 `status`
核对实际部署结果、恢复 journald 后再决定操作。成功写入日志流只证明传输已接收，目标主机的留存与权限仍需 #85 回读验收。手动调用的正常退出码保持不变，事件可通过
`journalctl SYSLOG_IDENTIFIER=devhot-site _UID=<专用UID>`
查询；实际读取权限由目标主机核验。不要直接调用内部 `host_journal_worker.py`。

`check`、`status`、`render`
保留调用者输出，不写 journal。子进程原始构建输出不写独立部署日志，也不进入公开站点；主机统一设置 journald 保留策略。`status`
读取内部受限状态，并在私有操作员输出中记录必要的 RootlessKit 文件身份、权限、capability 和启动链证明类型；这些身份字段使用独立允许列表，不包含完整配置、LAN 参数或秘密，也不伪造运行中 exe
inode。公开 `/maintenance/deployment.json`
继续使用 #83 允许列表投影，不包含日志、配置和实例值。

Timer 明确
`OnCalendar=*-*-* 02:00:00 Asia/Shanghai`、`Persistent=true`，同一 oneshot 加 OS 锁防止重叠。安装不启用 timer。只有 #85 完成真实环境验收并再次获得用户启用授权后，管理员才能执行 enable/start。之后日常部署允许已授权的 enabled
timer；安装验收 `check` 仍专门要求 disabled。

## 镜像、架构与真实环境证据

Nginx 测试运行时的固定源码 tarball 也属于准备输入。生产构建、实验室和 CI 在 gate 前由
`tools/prepare-nginx-source.ts`
下载并核对原有 SHA-256，写入新的只读文件；下载失败归入有界准备失败，不把该 SHA 记为坏内容版本。`DEVHOT_NGINX_SOURCE_TARBALL`
只选择预取文件，不更改版本或摘要。每个测试进程仍独立验证源码摘要、编译到自己的目录，并校验二进制/配方；不共享已编译运行时。预取文件缺失、损坏或为符号链接时失败，不悄悄联网回退。受控下载故障测试仍显式走原下载路径并保留全部拒绝与清理断言。

普通 `npm run gate`
在未指定预取文件时仍可从固定 URL 获取源码。本地需要把网络准备分离时，可先运行
`node tools/prepare-nginx-source.ts <新的绝对文件路径>`，再以
`DEVHOT_NGINX_SOURCE_TARBALL=<同一路径> npm run gate`
验证；文件必须新建，既有文件不会被覆盖。

两种镜像的唯一默认身份在 `deploy/lab_docker.py` 共用：Node `24.19.0-bookworm` 与官方
`nginx-unprivileged:1.30.4-alpine3.24`，均包含完整 SHA-256
digest。生产路径不接受镜像替换环境变量。拉取后检查 Linux、当前 daemon 架构及 RepoDigest；Nginx 的 CPU 架构必须与 daemon 一致。

更新精确版本须走独立代码 Issue/PR 和完整回归。管理员可用
`docker buildx imagetools inspect <完整版本标签>` 重新解析 manifest/index digest，核对所需
`linux/amd64` 或 `linux/arm64` manifest，再用固定 digest 拉取并通过 `docker image inspect`
验证 OS、Architecture、RepoDigests。标签后续指向变化不会自动更新已锁定身份，也不能把本机另一架构缓存当作兼容证明。

本票的确定性 OS 替身、真实本地 Git/文件/HTTP 与多容器实验只证明各自覆盖的边界。目标 Linux
VM 的实际账号、sudo/私有数据拒绝、user manager/linger、RootlessKit
capability 生效、LAN/客户端/IPv6 防火墙、daemon
socket 不外露、重启恢复、02:00 补跑与 journald，必须在 #85 逐项实测；GitHub
App/Ruleset 由 #81 完成。不得据此安装真实服务、启用 timer 或关闭 #85。

依据：[Rootless Docker 前提](https://docs.docker.com/engine/security/rootless/)、[用户级服务和低端口](https://docs.docker.com/engine/security/rootless/tips/)、[非登录账号与 Rootless 诊断](https://docs.docker.com/engine/security/rootless/troubleshoot/)、[docker group 权限](https://docs.docker.com/engine/install/linux-postinstall/)。
