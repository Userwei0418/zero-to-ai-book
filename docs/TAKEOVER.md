# 《从零开始学 AI》接手指南

第一次接手，先花五分钟做一次读者。打开[原 Sites 站的第一章预测题](https://ai-book-laboratory.lucien-alvarez748774.chatgpt.site/?chapter=upper-01#upper-01-predict-first-patch)，或在本地书站打开同一路径。猜“4 句”，运行原版 `patch1.py`，对照卡应显示你猜的 4 句和 Python 实测的 **3/6**。再改一行重跑，刷新，试着从“学习记录”回到刚才的单元。离线读原文可以从[上册导论](../course-source/上册/导论｜出发之前.md)和[下册总览](../course-source/下册/下册｜实践册：一点一点搭一个你自己的知识库.md)开始。

本次交接包的完整提交见包内 `manifest.json` 的 `main` 字段。以下记录用来追溯应用功能由来。

## 接的是哪个版本

| 环境 | 截至 2026-11-18 的依据 |
| --- | --- |
| 上次自建功能验收的源码基线 | `fc5ff7d7ca8bb564c6f2af810444e585b6405e41`。访客功能在 `61240b2` 引入，`93dd821` 补上真实 Chrome 验收与禁用存储时的阅读行为，`fc5ff7d` 更新交接记录。 |
| 原 Sites 站 | 最近记录为 v5、`d0fa0881e575f37fbbcf8b0d49f3f0d75b07aede`。使用平台身份、Worker 和 D1。读书与浏览器实验可匿名，在线导读与账号同步需要登录。发布到原站需要原项目权限、现有受众和 D1 绑定。[Sites 发布与回退](DEPLOYMENT.md) |
| 自建容器版 | 独立 Ubuntu 24.04 CI 使用本地 TLS、SQLite 与真实 gVisor，验证双账号和双访客同章执行隔离。Chrome 验证了两个独立浏览器配置分别保存书签，清除本地缓存可凭原 Cookie 恢复，清除 Cookie 后取得新身份，阻止 Cookie 时仍能阅读。[验收范围及三次 CI 日志](CONTAINERS.md#已实际验收的范围) |
| 接手方的目标机 | 仍需部署。公网 TLS、目标机负载、生产备份恢复、当前模型账号的真实生成，以及启用哪些远程课件，均须在接手环境实测。GPU 另需计算服务。 |

## 改书前先看这些约定

上册从一个读者能判断的问题起步，先预测，再运行代码找反例。下册持续搭建同一个资料助手，后章会导入前章的文件。桌面双页与手机单页使用同一章节及内容锚点定位。实验保留修改和历史输出，同章共用活跃内核，刷新或重置后按顺序重跑才能恢复变量。术语先展示课程释义，模型回答和可返回的原文引用另行显示。[设计取舍和验收图](DESIGN-HISTORY.md) · [产品需求](PRD.md) · [Notebook 验收](notebook-acceptance.md)

| 要修改的内容 | 权威输入和生成物 |
| --- | --- |
| 章节、代码、术语和素材 | [作者原稿与附件](../course-source/)中，上下册直属的 25 + 14 篇 Markdown 生成线上 39 篇。下册使用现行 12 章配套课件。共 165 个完整 Python 单元，34 个已通过真实 Pyodide，其余 131 个依赖远程 API 或 Linux。另有 GPU 示例。[内容审计](content-audit.md) · [实际 WASM 执行报告](../public/course/pyodide-validation.json) |
| 阅读器使用的内容 | [课程索引、章节、字幕与实验包](../public/course/)、[上线媒体](../public/media/)、[封面](../public/assets/)和[服务端导读上下文](../lib/generated/course-context.json)已随源码交付。[媒体来源和交付清单](../public/course/media-delivery.json)可追溯原路径与哈希。10 段视频中上册 05-2 仅恢复 108.949 秒，页面另附末段补读。 |
| 学习记录与运行数据 | [数据表](../db/schema.ts)定义学习状态及修订号、请求配额、导读缓存。[SQL 迁移](../drizzle/)用于初始化或升级。自建版的账号、签名密钥、真实记录在部署数据卷中；原站读者数据在其 D1 中。运维方分别交接备份与服务凭据。 |

## 在本机开发

1. 在源码根目录安装 Node.js 22.13 或更高版本、npm 和 Python 3。运行以下命令，以终端给出的地址打开书；普通开发机默认 `http://localhost:5173`。书页现成可用，首次运行浏览器 Python 时需要能下载 Pyodide。

   ```bash
   npm ci
   npm run dev
   ```

2. 修改界面从[阅读器](../components/book-reader.tsx)入手。改教材从上表的原稿开始，按[重导步骤](MAINTENANCE.md#修改课程并重新生成)准备 Python 制作依赖、ffmpeg 和 ffprobe，再生成章节、媒体及实验包。保留稳定锚点，复查下一章依赖和字号变化后的定位。
3. 在另一终端执行下列检查。固定版本 WASM 资源由首条命令下载；测试输出应确认 WASM 用例实际执行。媒体检查需装好前述制作工具。按[本地 D1 预览步骤](DEPLOYMENT.md#从仓库启动)可另验原站 Worker，容器版的数据库由 Web 启动时自动迁移。

   ```bash
   python3 scripts/prepare-pyodide-test.py
   npx tsc --noEmit
   NOTEBOOK_PYODIDE_DIR="$PWD/.sites-runtime/pyodide-test" node --test tests/*.test.mjs deploy/identity/identity.test.mjs
   python3 -m unittest discover -s services/sandbox/tests -q
   python3 scripts/prepare-media-delivery.py --verify
   npm run build
   node scripts/check-deploy-budget.mjs
   ```

## 在自己的域名启动

1. 在 Linux 准备 Docker Engine、Compose v2、指向目标机的 DNS 和 Caddy 可用的 80/443。检查已占用的端口、内存和磁盘。2 核 / 4 GiB 的机器可在同架构构建机预构建镜像，传到主机后启动。当前 Compose 只公开 Caddy，流量依次进入身份代理和 Web。静态图片、视频随 Web 镜像提供。[服务拓扑](../compose.yaml)
2. 首次安装时，在仓库外创建 `/etc/zero-ai-book`，权限 0700。按[首次初始化命令](CONTAINERS.md#启动书站)从[书站配置模板](../deploy/compose.env.example)和[模型课件配置模板](../deploy/lab-provider.env.example)创建环境文件及三个 0600 的密钥文件。用实际域名填写 `BOOK_DOMAIN`，用交付提交短 SHA 填写 `BOOK_RELEASE`。基础书站可以先使用空的密钥文件。升级时沿用已有文件与卷。
3. 在源码根目录的 Bash 中运行以下命令。若已导入相同标签的预构建镜像，可直接运行 `up`。访问自有域名的 `/api/health`，首次匿名访问应有 `persistenceConfigured: true`、`authenticated: false`。

   ```bash
   dc() { sudo docker compose --env-file /etc/zero-ai-book/compose.env -p zero-to-ai-book "$@"; }
   dc config --quiet
   dc build web identity
   dc up -d --no-build
   dc ps
   ```

4. 免登录身份由 HTTPS 入口签发 `__Host-book_guest`，有效期 180 天，最后 30 天再次使用可续期。每个浏览器配置分别保存进度；清除 Cookie 或换浏览器会取得新身份。共用电脑时分浏览器配置或登录各自的本站账号。访客记录与账号记录独立，可从“学习记录”导出、导入。站点存储被阻止时仍可在当前页面阅读与操作，服务端访客功能需要可用的签名 Cookie。[访客与账号行为](CONTAINERS.md#免登录时如何区分读者)
5. **启用 Linux 实验**时，先准备独立的学员引擎，可选同机无特权 rootless Docker 或隔离虚拟机。按[学员引擎预检及启动命令](CONTAINERS.md#启用需要完整-linux-或模型的课件)核对 daemon ID 与应用引擎不同、注册 `runsc`、验证 cgroup 限额，在学员引擎构建带版本的 guest 镜像。Web 和网关分别读取内容相同的随机令牌。填写私网网关地址、学员 socket、属组及镜像标签，运行 `dc --profile sandbox build sandbox-gateway` 后用该 profile 重新创建 Web 与网关。学员代码在无网络、非 root 的独立容器内运行，按读者和章节保留变量与临时文件。
6. **启用模型**时，读者导读凭据放入 `guide.key`，地址与模型名写入 `compose.env`；模型课件使用网关专属的 `lab-provider.env`，其受限代理仅支持指定模型的 Chat Completions。更改配置后重新创建对应服务。用此前未问过的问题验收导读，再实际运行一个模型课件，分别核对回答与用量。[模型与限额配置](../deploy/lab-provider.env.example)

| 默认限制 | 数值 |
| --- | --- |
| 访客导读上游请求 | 按 UTC 天，每位 3 次，全站访客合计 30 次；缓存命中无需请求模型。已登录账号导读默认每天 100 次。 |
| 访客远程执行 | 全站访客合计每日 60 次；本机浏览器实验不占此额度。网关模板另设每次执行最多 4 次模型调用。 |
| 2 核 / 4 GiB 起始配置 | 全站最多 2 个存活会话，每位 1 个，同时执行 1 个。每容器 256 MiB、1 核、64 PID；空闲 180 秒回收，单次默认 15 秒。目标机容量需以峰值内存、排队及拒绝实测。 |

## 验收与回退

- 在实际域名以两个独立、未登录的浏览器打开同一章，各做不同修改并刷新。启用沙箱后，让 A、B 各自写入同名变量和文件，重置 A，B 应能读到原值。可在运维终端运行下列测试，域名换成实际值。测试账号和 Linux 协议级 smoke（含临时会话数要求）见[容器验收手册](CONTAINERS.md)。健康接口的模型和运行时字段只报告配置情况。

  ```bash
  BOOK_PUBLIC_ORIGIN=https://book.example.org node deploy/verify-readers.mjs --guests
  BOOK_PUBLIC_ORIGIN=https://book.example.org node deploy/verify-readers.mjs --guests --sandbox
  ```

- 每次发版前记录源码 SHA、镜像标签和实际镜像 ID，停止写入后同时备份 `book-data`（SQLite 含 WAL）、`accounts`（含签名密钥）、`tls-data`、`tls-config`，并加密保存站外配置。旧版兼容当前数据库时，切回旧配置和镜像再验收；涉及数据回退时，先在新空卷恢复同一时间点的备份，验证测试账号、学习进度及 SQLite 完整性后再切换入口。[备份及恢复命令](CONTAINERS.md#备份升级和恢复)
- 下次交接请记录改动理由、提交、实测环境、验收结果和待验证项。原站发布、远端 GPU、供应商账号、公网域名与目标机恢复演练各有独立的外部条件。[原站及原始历史](HANDOFF.md) · [服务器规划](planning/服务器配置与部署设计.md)
