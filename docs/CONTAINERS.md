# 在自己的域名上运行交互书

这套 Compose 默认允许免登录阅读。访客可以翻页、看视频、改代码、保存进度，并使用管理员已启用的 AI 导读和 Linux 实验。需要跨设备同步的读者可以选用本站账号。自建站与原 Sites 站点各自维护身份、学习记录和模型配置。[Sites 发布流程](DEPLOYMENT.md)

| 服务 | 可以连接谁 | 持久化内容 |
| --- | --- | --- |
| Caddy（`edge`） | 公网 80 转 HTTPS，443 代理到 `identity:8080` | TLS 证书和配置卷 |
| 读者身份（`identity`） | 书站 `web:3000`；向书站传入已验证身份 | 账号、密码校验信息、会话签名密钥 |
| 书站（`web`） | 本地 SQLite、可选的导读模型、私网 `sandbox-gateway:8090` | `/data/course.sqlite` 及 WAL 文件，含进度、导读缓存、配额 |
| 实验网关（`sandbox-gateway`） | 专用学员 Docker daemon；启用模型课时可访问单独的上游 | 当前读者与章节的临时容器；课件和编辑记录由书站管理 |

仅 Caddy 发布宿主端口。账号服务从请求中清除外来身份，再根据本站会话写入稳定的读者 ID。应用与账号容器都没有 Docker socket。教学模型的真实密钥只在网关的模型代理端。单个学员容器禁用网络、按固定镜像启动，以非 root 用户运行，并限制 CPU、内存、进程和临时目录。[沙箱实现与协议](sandbox-deployment.md)

## 免登录时如何区分读者

书页首次打开时向同源入口领取 `__Host-book_guest`。入口生成 192 位随机值，用服务器密钥签名，通过 HTTPS 写入仅本站可用的 HttpOnly Cookie。浏览器回传、服务端验签后，书站才允许读写这个访客的记录。有效期 180 天，进入最后 30 天时再次打开书可续期。管理员备份身份签名密钥与数据库，可以在恢复站点后继续识别仍持有效凭证的访客。

| 读者的操作 | 进度和实验 |
| --- | --- |
| 使用同一浏览器配置再次打开书，或从 Wi-Fi 换到手机热点 | 继续自己的阅读位置、代码和学习记录。仍在存活期的同章 Linux 实验可继续使用变量和文件 |
| 两名学生使用同一个 Wi-Fi、相同型号手机和浏览器 | 两份独立 Cookie，各自拥有进度和实验。IP、浏览器类别、设备型号均不参与身份判断 |
| 两人共用同一台电脑、同一浏览器配置 | 看到同一份访客记录。在共享电脑上为每位读者使用不同浏览器配置，或登录各自的本站账号 |
| 换浏览器、清除本站 Cookie，或结束隐私浏览后重新进入 | 取得新的访客身份。账号模式可在多台设备打开该账号的进度。账号与访客独立保存。希望搬走访客进度时，在原浏览器的“学习记录”中导出，再到目标浏览器或账号导入 |
| 浏览器拒绝本站 Cookie | 仍可阅读、使用浏览器 Python。服务器需要能验证访客凭证才能开放访客同步、模型及远程实验 |

访客导读默认每位每天 3 次，全站访客合计每天 30 次上游调用。访客 Linux 执行请求默认全站每天最多 60 次。三项分别由 `GUEST_AI_DAILY_LIMIT`、`GUEST_AI_SITE_DAILY_LIMIT`、`GUEST_RUNTIME_SITE_DAILY_LIMIT` 配置。一天按 UTC 计算。新领 Cookie 会得到新的个人额度，全站额度继续累计。缓存命中的导读和浏览器本地实验不会占用这些调用额度。Linux 按执行请求计数，一次运行内模型课件的调用次数另受实验网关限制。

## 已实际验收的范围

2026 年 11 月 18 日，提交 `953d178` 在临时 Ubuntu 24.04 机器上构建并启动整套 Compose 服务。两名读者经 HTTPS 登录，在同一设备切换后各自取回学习记录；同时进入同一章时，变量、文件、输出和执行次数分别保存在两个 gVisor 容器里。重置或中断其中一位，另一位仍能继续原实验。另验收了多文件导入、生成 PNG、超时回收、空环境重启与会话清理。该作业使用测试账号及本地 TLS，两个会话可同时执行，未调用付费模型或目标主机。2 核/4 GiB 生产起始配置仍限制为一次执行。[真实容器验收记录](https://github.com/Userwei0418/zero-to-ai-book/actions/runs/44330536479)

## 启动书站

以下命令在源码根目录的 Bash 中执行。需要 Linux、Docker Engine 和当前 Docker Compose v2，准备好能解析到此主机的域名，开放 TCP 80 和 443 给 Caddy。磁盘需同时容纳源码、构建缓存、镜像、媒体、数据卷和备份。如在资源较紧的机器构建，可先在同架构构建机生成镜像，再用 `docker save/load` 或自己的镜像仓库传到运行主机。Caddy 持久化卷应在重启和升级后保留。[Caddy 自动 HTTPS](https://caddyserver.com/docs/automatic-https)

1. 新安装时建立站外配置目录。下面的初始化命令只执行一次；升级时沿用已有文件。默认应用引擎采用普通 Linux Docker 的 UID 映射；启用 user namespace remap 时需按实际映射调整密钥文件属主。

```bash
cfg=/etc/zero-ai-book
sudo install -d -m 0700 "$cfg"
sudo install -m 0600 deploy/compose.env.example "$cfg/compose.env"
sudo install -m 0600 deploy/lab-provider.env.example "$cfg/lab-provider.env"
sudo install -o 1000 -g 1000 -m 0600 /dev/null "$cfg/guide.key"
sudo install -o 1000 -g 1000 -m 0600 /dev/null "$cfg/web-gateway.key"
sudo install -o 10002 -g 10002 -m 0600 /dev/null "$cfg/gateway.key"
sudoedit "$cfg/compose.env"
```

把 `BOOK_DOMAIN` 改为实际域名（不含协议、路径或端口），将 `BOOK_RELEASE` 设成当前提交的短 SHA，保留作回退标识。需要 AI 导读时，用安全的编辑器或 secret 管理器把**仅用于读者导读**的 API key 写入 `guide.key`，再核对供应商地址、模型名和每日额度。留空可先验收书页和账号。密钥文件只挂给指定服务。库外目录需保持 0700，密钥文件 0600 且属主如上。实验模型的凭据只使用 `lab-provider.env`。

2. 构建并启动。以下 `dc` 函数在之后的命令中沿用。它显式选定项目和配置，避免切换目录或环境变量时误开一组空卷。

```bash
dc() { sudo docker compose --env-file /etc/zero-ai-book/compose.env -p zero-to-ai-book "$@"; }
dc config --quiet
dc build web identity
dc up -d --no-build
dc ps
dc logs --tail 50 web identity edge
```

Web 镜像启动时自动按顺序应用仓库中的 SQLite 迁移，然后启动 Next.js standalone 生产服务器。读者账号目录自动初始化。打开自有域名的 `/api/health`，匿名状态应返回 `persistenceConfigured: true`、`authenticated: false`，尚未配置模型和网关时对应字段为 false。静态媒体在书站镜像内，首次运行浏览器 Python 时读者网络还需能访问 Pyodide CDN。

3. 可选。需要跨设备学习或验证账号功能时，再建立本站账号。普通访客可直接打开书。运维终端需为 Bash。密码 12–256 个 UTF-8 字节，此写法隐藏输入，也不会把密码写入命令历史。读者在 `/signin-with-chatgpt` 用本站用户名密码登录；该兼容路径会进入自托管登录表单。测试完成后，可按同样方式给实际读者开账号。密码验证使用独立盐和 scrypt，同时最多校验两次；账号容器上限 512 MiB，容纳校验期间的内存峰值。

```bash
provision_reader() {
  local reader_password
  sudo -v || return
  IFS= read -r -s -p 'Reader password: ' reader_password || return
  echo
  printf '%s' "$reader_password" | dc exec -T identity node deploy/identity/provision.mjs "$@"
}
provision_reader acceptance-a
provision_reader acceptance-b
# 管理员重设密码，保留原读者 ID 和学习数据，并使旧会话失效
# provision_reader --reset acceptance-a
```

可从不同浏览器分别登录这两个账号，再访问首页。账号、SQLite、证书使用各自的命名卷。普通 `dc restart` 会保留它们。

## 启用需要完整 Linux 或模型的课件

2 核 / 4 GiB 可先运行书站、账号和浏览器实验；实际承载量要按目标机器余量测试。默认学员服务上限为两个存活会话、每位读者一个，同时最多实际执行一个。每个会话只属于一位访客或账号读者，以及一个章节，每个学员容器内存硬限为 256 MiB、CPU 1 核、PID 64。会话闲置默认 180 秒后清理，超时默认 15 秒。书里保存的代码可以重跑，临时变量与文件在会话清理后释放。

**先准备独立学员引擎。** 管理员要为网关提供一个指向专用 Docker daemon 的 Unix socket。两种方式都可使用，不要求第二台实体服务器。

- **同机。** 用单独的无特权 Linux 用户安装 rootless Docker，引擎、数据目录和用户 home 均与运行书站的主 Docker 隔离。这个用户不要加入应用宿主的 docker 组，也不要授予读取站点配置目录的权限。Ubuntu 需具备 rootless Docker 的 uidmap、subuid/subgid、用户 systemd 服务和 cgroup v2。新建专用用户后启用 `loginctl enable-linger 用户名`；在其登录会话运行 `dockerd-rootless-setuptool.sh install --force`。按目标机器适配 gVisor，将官方安装的 `runsc` 注册到这个用户自己的 Docker 配置（通常是 `~/.config/docker/daemon.json`，新引擎可使用[配置模板](../deploy/learner-daemon.json.example)，填写实际的受信任可执行文件绝对路径；已有配置则合并 `runtimes.runsc`）再 `systemctl --user restart docker`。核对其 `/run/user/<UID>/docker.sock`，确认 systemd 已向该用户委派 CPU、内存与 pids。仅在此组合通过下面的运行和限额检查时启用。[Docker rootless 安装](https://docs.docker.com/engine/security/rootless/) · [rootless cgroup 限额](https://docs.docker.com/engine/security/rootless/tips/) · [gVisor rootless](https://gvisor.dev/docs/user_guide/rootless/)
- **隔离虚拟机或独立主机。** 在只运行学员容器的机器上安装 Docker、注册 `runsc`，用只允许管理员使用的私有隧道把该 daemon 的 Unix socket 转发到应用主机。例如在已验证主机密钥的运维账号下，创建属组为专用 socket 组的受保护本地目录，然后运行 `ssh -NT -o ExitOnForwardFailure=yes -o StreamLocalBindMask=0117 -L /run/zero-ai-learner/docker.sock:/var/run/docker.sock learner-admin@learner-vm`。把隧道作为开机服务维护，检查本地 socket 的属主、属组和 0660 权限。应用主机自己的 rootful Docker socket（或其别名）不能挂给网关；持有该 socket 的进程等同拥有该宿主管理权限。[gVisor 安装](https://gvisor.dev/docs/user_guide/install/) · [OpenSSH Unix socket 转发](https://man.openbsd.org/ssh)

**在同一学员引擎上构建、预检，再启网关。** 下面的 `sock` 按实际替换。不要仅凭路径名区分两个 daemon；检查实际引擎 ID 和资源能力。所有 guest 构建和检查操作显式使用 `-H`。可在可信构建环境完成离线依赖下载，但最终 guest 镜像必须出现在学员引擎里。

```bash
sock=/run/user/1005/docker.sock
sudo test -S "$sock"
learner() { sudo docker -H "unix://$sock" "$@"; }
assert_separate_engine() {
  local app_id learner_id
  app_id=$(sudo docker info --format '{{.ID}}') || return 1
  learner_id=$(learner info --format '{{.ID}}') || return 1
  test -n "$app_id" && test -n "$learner_id" && test "$app_id" != "$learner_id"
}
assert_separate_engine || { echo '需要能与应用 daemon 区分的学员引擎'; exit 1; }
learner info --format 'runtimes={{json .Runtimes}} memory={{.MemoryLimit}} swap={{.SwapLimit}} pids={{.PidsLimit}} cpuQuota={{.CPUCfsQuota}} cpuPeriod={{.CPUCfsPeriod}}'
sudo stat -Lc 'socket=%n gid=%g mode=%a' "$sock"
release=$(git rev-parse --short HEAD)
guest="zero-to-ai-guest:$release"
learner build -t "$guest" -f services/sandbox/Dockerfile services/sandbox
learner run --rm --runtime=runsc --network=none --read-only --user=10001:10001 \
  --memory=256m --memory-swap=256m --cpus=1 --pids-limit=64 --entrypoint python \
  "$guest" -I -c 'import os; print(os.getuid(), os.path.exists("/var/run/docker.sock"))'
```

预期能看到 `runsc`、全部资源能力 true、最后一行 `10001 False`。用 `docker inspect` 和目标系统 cgroup 计数/上限验证内存、进程与 CPU 配额实际生效，特别是 rootless 模式。学员 daemon 专用于该项目，网关获得的是该引擎的管理权限；学员程序容器内没有引擎 socket。缺少隔离/限额时保留基础书站，先解决运行时兼容性。不要将另一个 rootful daemon 的 socket 放在同一宿主来代替 rootless 权限边界。

在 `compose.env` 启用 `BOOK_SANDBOX_URL=http://sandbox-gateway:8090`，按上一步输出填写 `LEARNER_DOCKER_SOCKET`、`LEARNER_SOCKET_GID`、完整带标签的 `BOOK_GUEST_IMAGE`。网关与 Web 私网使用同一个随机 token，各自从不同属主的私密文件读取。以下初始化只在首次接入时执行，若轮换需同步重建相关服务。需要模型课件时，另外在 `lab-provider.env` 设置独立的模型凭据与限额。模型超时和整个 cell 的运行时限共同生效；对多次调用课件可按负载逐步上调，单 cell 最大 60 秒。

```bash
sudo sh -eu -c 'umask 077; openssl rand -hex 48 > /etc/zero-ai-book/web-gateway.key; install -o 10002 -g 10002 -m 0600 /etc/zero-ai-book/web-gateway.key /etc/zero-ai-book/gateway.key'
sudoedit /etc/zero-ai-book/compose.env
dc --profile sandbox config --quiet
dc --profile sandbox build sandbox-gateway
dc --profile sandbox up -d --no-build --force-recreate web sandbox-gateway
dc --profile sandbox ps
```

引擎或隧道重建 socket 后需要 `dc --profile sandbox up -d --force-recreate sandbox-gateway` 重新挂载。网关日志应显示已通过引擎预检；从书站运行一个 Linux 单元验证真实输出。`/api/health` 中的 `remoteRuntimeConfigured` 只表示书站配置齐全。启用的课件覆盖取决于镜像依赖与模型服务；当前没有 GPU 引擎。维护者可进一步运行下方双账号验收以及[真实网关 smoke 和资源验收](sandbox-deployment.md)。

网关协议的完整 smoke 同时保留某一读者的两章会话。为该项验收临时将 `LAB_ACCOUNT_SESSIONS` 设为 2、`LAB_SESSIONS` 至少为 2，重新创建网关；不需要提高并行执行数。执行后恢复日常上限并再创建网关。下面命令仅在网关容器内访问 loopback。可选的提供方联测会产生真实用量，需另行指定 `SANDBOX_SMOKE_MODEL=1`。

```bash
dc --profile sandbox up -d --no-build --force-recreate sandbox-gateway
dc --profile sandbox exec -T sandbox-gateway python /opt/gateway/smoke_test.py
```

## 在实际域名验收两个读者

免登录验收无需准备账号。用两个独立的浏览器配置打开同一章，在其中一个修改代码并刷新，另一个仍应看到自己的内容。可在 Node 22+ 维护终端执行以下命令。加上 `--sandbox` 还会在两个访客的 gVisor 容器中写入不同的变量和文件，并验证单独重置。

```bash
BOOK_PUBLIC_ORIGIN=https://book.example.org node deploy/verify-readers.mjs --guests
BOOK_PUBLIC_ORIGIN=https://book.example.org node deploy/verify-readers.mjs --guests --sandbox
```

在有 Node 22+ 的维护终端中，从两个专用测试账号的不同浏览器窗口登录。匿名窗口打开书页和媒体，试着修改一道浏览器 Python 题并运行；登录窗口 A 修改同一道题、产生进度，窗口 B 应仍见自己的旧值。切换回 A 并刷新，确认代码与阅读位置恢复。退出后匿名浏览应仍可使用，两人在同一浏览器轮流登录时也应各见自己的记录。测试完成后用一条新问题检查真实 AI 导读；具有模型访问权的课件还需要从书页执行一次真实上游调用。

可用验收脚本重复检查匿名访问、账户身份及数据隔离。为 A、B 准备专用的测试账号，将两个账号及密码通过环境变量 `BOOK_TEST_READER_A`、`BOOK_TEST_PASSWORD_A`、`BOOK_TEST_READER_B`、`BOOK_TEST_PASSWORD_B` 安全注入；也可在 0600 的文件中放一个含两个 `{"username":"…","password":"…"}` 对象的 JSON 数组，临时作为 stdin 输入。不要使用真实读者的账号。

```bash
BOOK_PUBLIC_ORIGIN=https://book.example.org node deploy/verify-readers.mjs < /secure/test-readers.json
# 已启动沙箱时额外验证两个读者的 Python 变量与文件各自隔离
BOOK_PUBLIC_ORIGIN=https://book.example.org node deploy/verify-readers.mjs --sandbox < /secure/test-readers.json
```

脚本会写入并清理临时学习记录。沙箱模式会重置两个测试会话，两位读者各需一个存活会话，顺序执行即可。新版本还应实际运行浏览器端初次加载、展示表格或图像、停止执行、恢复章节、视频定位和手机单页阅读；具体书页和预期结果见[验收用例](DEPLOYMENT.md#发布后用同一条学习路径验收)。

## 备份、升级和恢复

**一致备份。** 用 Caddy、身份服务、Web 全部停止写入的短维护窗口，同时备份用户账号和 SQLite 整个数据目录（含 WAL），并保存证书。先把运行中的提交 SHA、`BOOK_RELEASE`、guest 镜像标签和现用容器镜像 ID 写到运维记录。如果启用了沙箱，提前通知读者该阶段会关闭临时会话。下面针对默认项目名：

```bash
backup=$(sudo mktemp -d /var/backups/zero-ai-book.XXXXXXXX)
dc --profile sandbox stop edge identity web sandbox-gateway
for volume in book-data accounts tls-data tls-config; do
  sudo docker run --rm --network none \
    -v "zero-to-ai-book_${volume}:/src:ro" -v "$backup:/backup" \
    busybox:1.37.0 tar czf "/backup/${volume}.tgz" -C /src .
done
sudo ls -lh "$backup"
dc up -d --no-build
# 启用沙箱的环境，启动时改用 dc --profile sandbox up -d --no-build
```

卷归档含个人数据和签名/证书私钥，应和 `/etc/zero-ai-book` 一起加密备份到受控位置。归档 GitHub、镜像及课程媒体不能替代这份运行数据。学员容器与临时实验文件不在备份内。

**升级。** 先保留备份、旧源码和已运行的镜像标签，检出候选提交，给新镜像设置不同的 `BOOK_RELEASE`。构建成功后 `dc up -d --no-build`，启用沙箱时使用相同 profile 并更新学员引擎中的 guest 镜像。Web 成功完成迁移后才接流量。检查健康、双访客验收及选用的账号功能，记录新版本及镜像 ID。

**恢复演练与回退。** 在隔离测试主机或不同项目名的**全新空卷**先演练恢复。取同一时间点的四份归档和原版本镜像，先创建目标卷再解包，保留归档里的属主（账号和 Web 为 UID 1000），最后启动对应版本。以下命令只针对尚不存在的恢复卷。将 `backup` 设为实际备份目录；`zero-ai-restore` 使用自己的域名、配置目录和空闲的 80/443 入口。在原机并行演练时需要单独 IP/端口或保持原 Caddy 停止。

```bash
for volume in book-data accounts tls-data tls-config; do
  target="zero-ai-restore_${volume}"
  if sudo docker volume inspect "$target" >/dev/null 2>&1; then
    echo "恢复卷已存在，停止以免混入旧数据" >&2
    break
  fi
  sudo docker volume create "$target" >/dev/null || break
  sudo docker run --rm --network none -v "$target:/dest" -v "$backup:/backup:ro" \
    busybox:1.37.0 tar xzf "/backup/${volume}.tgz" -C /dest || break
done
# 确认四卷都成功恢复后，用相同项目名并指定演练站点的外部 env 文件启动：
# sudo docker compose -p zero-ai-restore --env-file /etc/zero-ai-restore/compose.env up -d --no-build
```

验证同一测试账号可登录并能读到备份时的学习进度，SQLite 通过完整性检查，再开展正式恢复。仅当旧应用兼容已升级数据库时，可以直接切回旧源码、配置及镜像标签并重新启动。需要回退数据库时，用备份恢复到新卷，核对恢复点后的新写入及损失范围再切换入口。清理前保留原卷；`docker compose down -v` 会删除项目数据。

本仓提供可构建配置和验收工具。本次交接使用 Compose 官方 Schema 核对拓扑，完整 Docker/gVisor、目标容量、公网 TLS、真实模型与生产备份恢复仍须按目标主机实际演练。
