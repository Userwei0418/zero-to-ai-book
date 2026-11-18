# 在本地开发，把更新发布到原站

GitHub 保存课程和应用源码。现网由 Sites 托管，使用 Worker 服务端、D1 数据库和平台登录身份。静态书页数据和媒体跟随发布包交付。浏览器中的 Pyodide 负责轻量 Python 实验，完整 Linux 和 GPU 实验各有单独的服务入口。[线上书籍](https://ai-book-laboratory.lucien-alvarez748774.chatgpt.site) · [设计及版本交接](HANDOFF.md)

自建 Ubuntu 采用[容器部署手册](CONTAINERS.md)，包含独立读者账号、SQLite、HTTPS 和按账号隔离的远程执行。下文覆盖原 Sites 站点。

## 从仓库启动

使用 Node.js 22.13.0 或以上版本、npm 和 Python 3。运行以下命令前确认检出了完整源码，包含 `package-lock.json`、`public/course/`、`public/assets/`、`lib/generated/`、`drizzle/` 和 `course-source/`。普通前端修改可以直接使用仓库里的课程产物。重导课程才需要另装 Python 编辑工具，详见[课程维护](MAINTENANCE.md)。

```sh
git clone https://github.com/Userwei0418/zero-to-ai-book.git
cd zero-to-ai-book
npm ci
npm run dev
```

终端会显示开发预览地址，普通本地环境默认使用 5173 端口。需要验证打包后的 Worker、静态文件和 D1 时，先结束开发预览，在项目根目录构建。下面两次迁移适用于全新本地数据库，已有数据库仅执行尚未应用的文件。

```sh
npm run build
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0000_mute_silhouette.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute DB --local --config dist/server/wrangler.json --persist-to .wrangler/state --file drizzle/0001_fantastic_corsair.sql
npm start
```

打开终端打印的本地地址和该地址的 `/api/health`。干净环境应显示 `persistenceConfigured: true`。本地预览没有平台登录身份时，`/api/state` 返回匿名状态，仍可验收书页、代码编辑、浏览器实验和本机阅读进度。云端账号同步和需登录的 AI 调用要在具有平台身份的测试环境验收。

## 检查一个候选版本

```sh
npx tsc --noEmit
node --test tests/*.test.mjs
python3 -m unittest discover -s services/sandbox/tests -q
python3 scripts/prepare-media-delivery.py --verify
npm run build
node scripts/check-deploy-budget.mjs
```

要运行书中实际使用的 Python 解释器，可以下载并校验固定版本 Pyodide 0.27.7 的运行文件和课程依赖。首次约 32 MiB，后续复用本地缓存。详见[Notebook 验收记录](notebook-acceptance.md)。

```sh
python3 scripts/prepare-pyodide-test.py
NOTEBOOK_PYODIDE_DIR="$PWD/.sites-runtime/pyodide-test" node --test tests/*.test.mjs
```

2026-11-18 交接复核在本地空数据库按顺序成功执行了两份迁移，打包后的 Worker 返回 `/api/health` HTTP 200，D1 绑定存在。在 Node.js 24.22.1 上准备固定 WASM 资源后，Node 测试 85 项全部通过，零跳过，覆盖 34 个可在浏览器执行的课程单元、表格和图像输出、停止与重启。省略 WASM 资源时，通过 61 项，跳过 3 项顶层测试。Python 网关测试通过 51 项。媒体检查通过 233 个引用、459 个资产和 10 个 fast-start 视频。发布预算检查为 596 个文件、展开 123.01 MiB，脚本限额 252 MiB。真实模型、远端沙箱和生产数据库均需在相应环境单独验收。

## 配置归属

| 生效位置 | 名称 | 作用和验证 |
| --- | --- | --- |
| Sites 绑定 | `DB` | D1 保存读者学习状态、导读缓存和请求配额。托管发布沿用原站绑定。本地使用独立预览库。 |
| Sites 服务端 | `TOKENPLAN_API_KEY`、`TOKENPLAN_BASE_URL`、`TOKENPLAN_MODEL`、`AI_DAILY_LIMIT` | 密钥授权模型调用，其余项指定兼容接口、模型和按账号每日限额。使用新问题实际提问并看到完整回复，才能确认真实生成链路。 |
| Sites 服务端 | `SANDBOX_API_URL`、`SANDBOX_API_KEY` | 指向独立 HTTPS Linux 网关；密钥与网关的 `SANDBOX_TOKEN` 或 `SANDBOX_TOKEN_FILE` 所提供的值一致。 |
| 独立 Linux 网关 | `SANDBOX_IMAGE`、`SANDBOX_TOKEN` 或 `SANDBOX_TOKEN_FILE`；模型课另配 `TOKENPLAN_API_KEY`、`TOKENPLAN_BASE_URL`、`TOKENPLAN_MODEL` | 使用 Docker 和 gVisor 隔离学生代码。模型代理的凭据只在网关宿主使用。其余限制见 `services/sandbox/sandbox.env.example`。 |
| Sites 服务端 | `GPU_API_URL`、`GPU_API_KEY` | 需要另行部署符合运行协议的 GPU 服务。仓库提供 Web 接口，GPU 运算环境待接入。 |

凭据通过各部署环境的 secret 管理注入。能克隆公开仓库的开发者可以本地跑项目；要更新原站，还需要原 Sites 项目的部署权限及相应的环境配置。迁移生产读者数据时需另行备份 D1，并验证恢复权限与目标库。仓库内的 SQL 是表结构，读者进度与账户数据留在实际数据库。若曾在沟通渠道分享部署或模型凭据，在使用对应环境前轮换并通过私密渠道交接。

## 发布到原有 Sites 项目

1. 记录上一次成功发布的站点版本 ID 和源码提交。取 GitHub 上准备发布的提交 SHA，完成前述测试。确认有权限操作 `.openai/hosting.json` 所指的原项目，保留已有受众设置和 `DB` 绑定。GitHub 的推送与 Sites 的发布是两个操作。
2. 在有 Sites 发布能力的环境，通过 `get_site` 确认项目和当前版本，使用 `create_source_repository_write_credential` 与 `site-workflow.mjs` 打开原项目托管源码工作区。比较双方提交和文件差异，再把候选提交的改动合入托管工作区，保留线上已有的未合并改动。临时写入凭据交给发布工具使用。
3. 如修改了 `db/schema.ts`，先运行 `npm run db:generate`。审查并提交新 SQL、`drizzle/meta/` 快照和 journal，在本地升级一份已有结构库。保留已部署迁移原文，后续修改追加迁移。列变动需同时考虑上一版 Worker 对升级后数据库的读写。
4. 使用 Sites 的 `site-workflow.mjs`，复用打开项目时的源码结果，按顺序调用发布环境提供的 `build-site.mjs` 与仓库的 `scripts/check-deploy-budget.mjs`，传入绝对归档路径。打包工具返回项目 ID、托管源码 SHA 和归档结果。它们共同标识待发布的版本。上述两个 Sites 工作流脚本由发布环境提供。
5. 已确认 owner-private 受众时，使用 `save_version_and_deploy_private`，或分步保存并执行 `deploy_private_site_version`。其他受支持受众使用 `save_site_version` 和 `deploy_site_version`。传入同一次打包的结果，等待部署完成。平台在上传 Worker 前应用待执行的 D1 迁移。保存 GitHub SHA、托管源码 SHA、站点版本 ID、部署结果及验收日期，便于定位两边的对应版本。

**回退。** 优先选择已知正常、与当前数据库兼容的已保存归档版本，按相同受众重新部署并复跑下表。若没有可部署的旧归档，从已知正常提交恢复应用代码，保留已应用的迁移历史，重新构建并发布。换回 Worker 不会撤销 D1 迁移。即使应用发布失败，迁移也可能已完成，重试前先查平台迁移状态，按实际情况追加兼容修复。有数据变更时，恢复操作依赖经授权的生产备份和恢复验证；当前交接未演练生产数据恢复。

## 发布后用同一条学习路径验收

| 操作 | 应观察到的结果 |
| --- | --- |
| 打开第一章预测题，选“4 句”，运行原版 `patch1.py` | 真实 Python 得到 3/6，可对照预测；代码编辑与展开后关闭都回到原位置。[打开实验](https://ai-book-laboratory.lucien-alvarez748774.chatgpt.site/?chapter=upper-01#upper-01-predict-first-patch) |
| 在同章前后两个单元共享变量，再停止长任务、重置、从头运行本章 | 前一单元的变量可用；终止后界面可继续操作，重置后从干净环境开始。换设备时依靠保存的代码和顺序重跑恢复变量。 |
| 翻页、改字号、从学习记录跳回实验，打开视频并从文字稿跳到时间点 | 书页仍落在原内容，窄屏布局可读；视频能播放和定位。使用同一个测试账号检查刷新及第二设备同步。 |
| 在测试账号下点术语，询问一个未缓存的新问题，再追问 | 流式响应结束、能显示回答或具体错误。若失败，先看同站 `/api/health`，登录后用 `/api/health?checkAI=1` 检查上游模型列表，再测真实生成请求。仅能列出模型不足以证明生成成功。 |
| 打开模型课、Linux 课、GPU 课各一个单元 | 未接入的运行时应明确显示不可用，代码可编辑。已接入时应能获得真实输出、错误和中断响应。 |

## 独立 Linux 和 GPU 的上线条件

独立 Linux 网关的准备、安装、systemd、TLS 和真实验收步骤见[沙箱部署手册](sandbox-deployment.md)。在目标主机验证 Docker + `runsc` 和资源限额，确认 HTTPS 可达后，经私密通道设置 `SANDBOX_URL`、`SANDBOX_TOKEN`，执行 `python3 services/sandbox/smoke_test.py` 检查真实隔离、会话、超时和中断，并完成手册列出的隔离检查。要验证会产生提供方调用的模型实验，在有额度的测试环境显式设置 `SANDBOX_SMOKE_MODEL=1` 再运行。通过后在 Sites 配置对应服务并从书页复测。

2 核、4 GiB 主机能承载的并发实验数尚未在目标机测量。以目标 Linux 课件做小并发压测，记录已有服务占用、容器峰值内存、排队时间和网关拒绝情况，再选择会话与并发上限。GPU 需要单独的算力和服务验收。
