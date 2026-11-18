# 《从零开始学 AI》项目交接包

交接日期为 **@VERSION@**。恢复后的项目位于 `zero-to-ai-book/`，Git 主线提交为 `@MAIN@`，共有 **@FILECOUNT@** 个跟踪文件。交互书、课程原稿、配套代码、媒体、设计、容器配置和测试都在这次快照里。

**先看产品。** 打开[图文 PRD](guide/docs/design/零基础学AI_PRD_含设计图.pdf)、[第一章实验的实际页面](guide/docs/acceptance/ai-book-compact-prediction.jpg)或[课程介绍](guide/docs/editorial/课程介绍.md)。要接手开发与运维，可以先读[接手指南](guide/docs/TAKEOVER.md)。文档提到的程序路径以恢复后的项目根目录为准。

## 1. 还原可继续提交的项目

安装 Git 后，解压 ZIP，在含有 `history.bundle` 的文件夹打开终端。以下操作可离线完成，目标目录请用一个新名称。

```sh
git clone -b main ./history.bundle zero-to-ai-book
cd zero-to-ai-book
git rev-parse HEAD
git status --short
```

第一条查询会显示上面的完整提交号，第二条查询应没有输出。这里已具备公开主线和三个公开归档分支。在需要向 GitHub 拉取或提交修改时，把远端从本地交接包切回项目地址，使用你自己的仓库权限。

```sh
git remote set-url origin https://github.com/Userwei0418/zero-to-ai-book.git
```

如需追溯最初建站过程，在源码根目录运行下列命令。包内的公开归档可离线还原 17 次 Sites 开发提交，其中包含上线 v5。作者私人留存的旧附件及第 18 次作者归档的复查方式见 `docs/HANDOFF.md`。

```sh
python3 scripts/restore-original-history.py
git log --oneline course-history
```

## 2. 在本地打开书

在源码目录使用 Node.js 22.13 或以上版本及 npm。首次安装依赖需要网络。浏览器第一次运行 Python 还需获取固定版本 Pyodide 资源，容器构建也需要拉取基础镜像。

```sh
npm ci
npm run dev
```

打开终端显示的本地网址。在第一章“规则总也写不完”选择“4 句”，运行原版 `patch1.py`，应看到自己的预测与真实结果 **3/6**。要修改书页打开 `components/`，改教材从 `course-source/` 入手。开发命令与回归用例见 `docs/TAKEOVER.md`。

## 3. 在自己的服务器部署

从源码目录的 `docs/CONTAINERS.md` 开始。先确认服务器上的已有服务、可用磁盘和内存，准备域名、HTTPS 入口及站外配置目录。先启动书站、身份服务和 SQLite，用两个独立浏览器验证访客记录，再按需要启用 AI 导读及专用 gVisor 学员引擎。2 核 / 4 GiB 的起始值为两个存活沙箱、一个同时执行。备份、升级、恢复步骤也在这份手册里。

- 自建版打开即读，访客 Cookie 区分学习记录，同一章的远程实验按读者隔离。原 Sites 部署与自建版独立。
- 书站源码和测试夹具随包交付。实际读者数据、账号、证书、私钥、供应商密钥与生产备份由站点运维方通过独立渠道交接。
- 最近一次已验证的书站功能包括真实 Chrome 访客书签、禁用 Cookie 的阅读行为和双访客 gVisor 隔离。上海目标机的部署、生产模型和容量仍须现场验证。[实际验收日志](https://github.com/Userwei0418/zero-to-ai-book/actions/runs/44337122722)

## 4. 查证包内容

`manifest.json` 记录源码提交、四个完整分支指针和包内各文件的 SHA-256。发布页另附整个 ZIP 的 `SHA256SUMS.txt`。把二者放在同一目录，在 macOS 运行 `shasum -a 256 -c SHA256SUMS.txt`，在 Linux 运行 `sha256sum -c SHA256SUMS.txt`。完整恢复校验可在源码目录执行 `python3 scripts/verify-handoff.py /实际路径/交接包.zip --restore-history`。

维护记录从 `docs/DESIGN-HISTORY.md` 和 `docs/HANDOFF.md` 接续，按主题保存设计取舍与验收依据。已有技术决定已整理入库，原始聊天和私人账号记忆由各自的原系统管理。
