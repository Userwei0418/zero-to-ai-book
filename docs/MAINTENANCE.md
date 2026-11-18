# 课程、数据与程序怎样一起维护

## 教学设计如何落到书页上

上册给出一个当时确实会遇到的问题，让读者先提出办法，观察自己的办法在哪种输入上失效，再引入下一章需要的概念。下册延续同一个资料助手，前面做出的数据、模块和工具会进入后面的实验。所以除了本章示例，每次编辑也要关心谁会在后续章节导入这个文件。

第一章的 `patch1.py` 能看到这个过程。读者先猜六题得分，再用实际 Python 运行。对照卡读取本次程序输出，原课的示例答案单独折叠。修改代码、导入文件或评分输出格式后，要分别检查本次结果、上次结果和示例答案的标签。预测题与课程块在 [lib/course-predictions.ts](../lib/course-predictions.ts) 中关联。块 ID 来自原文或代码内容，修改题目附近的代码或句子后，须复查题目锚点和课程深链。

桌面双页、手机单页表达同一段内容。阅读进度以章节和内容锚点保存，字号或窗口变化会重新分页。长代码可以展开到工作区，收起后回到原处。视频在点播时加载，文字稿时间点可定位到同一页的播放器。术语先提供课程定义，读者有进一步问题时再向模型提问。

## 文件从哪里来

| 内容 | 编辑入口 | 使用位置 |
| --- | --- | --- |
| 作者原稿和课件 | `course-source/上册/`、`course-source/下册/`、`course-source/attachments/` | `scripts/import-course.py` 从两册顶层 Markdown 生成章节、目录、实验文件和服务端课程上下文 |
| 术语、图注、字幕 | `public/course/terms-source.json`、`scripts/media-editorial.json`、`public/course/captions/` | 术语导读、插图说明、视频字幕和可跳转文字稿 |
| 网站内容与媒体 | `public/course/chapters/`、`public/media/`、`public/assets/`、`lib/generated/course-context.json` | 浏览器与导读 API 都能直接使用仓库里的产物 |
| 下册跨章依赖 | 作者课件和各章现存代码 | `scripts/prepare-experiment-support.py` 生成 `public/course/experiment-support.zip`，供下载时还原目录与文件 |
| 产品与视觉依据 | `docs/PRD.md`、`docs/design/` | 课程编辑、界面开发和发布验收 |
| 服务端数据结构 | `db/`、`drizzle/`、`app/api/` | 登录后的进度、对话、配额与缓存存入绑定的 D1。维护仓库收录结构和迁移；读者实际数据按部署环境管理 |

## 修改课程并重新生成

在仓库根目录运行。Python 3 需要 `mistune>=3,<4`、`bleach>=6,<7` 和支持 WebP 的 Pillow，系统需安装 `ffmpeg`、`ffprobe`。建议在干净的 Git 工作树中操作，便于检查哪些导出物发生了变化。

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install 'mistune>=3,<4' 'bleach>=6,<7' Pillow
python scripts/import-course.py --source ./course-source --check-browser
python scripts/prepare-media-delivery.py
python scripts/prepare-media-delivery.py --verify
python scripts/prepare-experiment-support.py
git diff --stat
```

导入器核对 39 篇顶层 Markdown，并按文件名推导章节 ID。增删章节时，同步修改 `scripts/import-course.py` 的篇数、命名映射和相关测试。上册按章节从作者正文的代码块和前章积累生成实验文件，下册另读取 `course-source/下册/attachments/从零开始学AI-下册配套课件.zip`。当前公开原稿足以重建已发布课程。2026 年 11 月 18 日从公开仓库重新导入并运行媒体处理后，39 篇章节 JSON 的内容逐项与上线数据一致，1,357 个实验文件条目一致，下载用 `experiment-support.zip` 逐字节相同。作者旧版补充快照单独保管。更换课件时请复查跨章依赖、实验输出和下载包。

`--check-browser` 实际用本机 CPython 检查标为浏览器可运行的课程代码。要验证生产 Worker 对同一段程序的行为，还要单独跑 Pyodide 的 WASM 测试。替换视频或调整剪辑后，要同时检查字幕时间轴、海报和原有片段说明。

## 检查与发布

```sh
npm ci
npx tsc --noEmit
node --test tests/*.test.mjs
npm run build
node scripts/check-deploy-budget.mjs
```

测试需要 `python3` 来实际运行导出的实验。使用 [Notebook 验收记录](notebook-acceptance.md) 中的固定版本 Pyodide 和依赖，在运行测试前将 `NOTEBOOK_PYODIDE_DIR` 指向已准备的运行时目录。若终端报告 WASM 用例跳过，此次测试只覆盖已执行的项目。

上线前，在待发布版本实际打开一道预测题、运行修改过的代码，从学习记录跳回实验，再从视频文字稿跳到指定时间。模型问答检查要区分真实上游调用和模拟上游的自动测试。保存课程原稿、生成内容、关联代码和检查记录到同一次变更，发布完成后记下与线上版本对应的提交。

服务端的 `TOKENPLAN_API_KEY`、`TOKENPLAN_BASE_URL`、`TOKENPLAN_MODEL` 控制导读模型，`AI_DAILY_LIMIT` 控制每个账号的每日额度。数据库绑定名为 `DB`。`SANDBOX_API_URL` 与 `SANDBOX_API_KEY` 用于 Linux 执行服务，GPU 服务使用 `GPU_API_URL` 与 `GPU_API_KEY`。凭据由各环境单独注入。

当前生产站点使用托管 Worker、D1 和平台身份。GitHub 保存源码与版本，线上发布由原有部署流程执行。运行服务的隔离、模型代理和资源限制见 [沙箱部署说明](sandbox-deployment.md)。截至本次归档，线上独立 Linux 与 GPU 沙箱仍待接入。

## 本次迁移的基线

本次整理以现网提交 `d0fa0881e575f37fbbcf8b0d49f3f0d75b07aede` 为基线。课程原稿、制作素材、原型和发布用数据在此后纳入同一维护分支。部分早期附件保留原文件名，便于 Markdown 嵌入和导入脚本解析引用。媒体交付清单记录了原素材与阅读版本的对应关系。

当前课程内容、实验夹具、字幕和媒体随代码保存。读者的个人对话、学习数据库及部署环境中的密钥由对应环境管理。
