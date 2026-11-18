# 接手项目

这本书的接手资料可在没有原聊天账号的环境中使用。仓库保存作者原稿、可编辑实验、发布用数据、程序、产品决定和验证方法。历史对话中留下的有效决定已按主题整理。私人对话、账号记忆、读者学习记录和部署密钥分别留在其原有系统中。

## 新开发者先读什么

| 要回答的问题 | 查看位置 |
| --- | --- |
| 一本交互书要做到什么，为什么这样教 | [产品需求](PRD.md) · [历次设计决定与验证方法](DESIGN-HISTORY.md) |
| 如何修书页、维护课程、重导实验 | [项目首页](../README.md) · [课程维护指南](MAINTENANCE.md) |
| 原型和实物效果有什么区别 | [设计图](design/) · [正式站点验收图](acceptance/ai-book-compact-prediction.jpg) |
| 在自己的服务器部署、配置免登录访问与隔离运行 | [自建容器部署](CONTAINERS.md) |
| 本地怎样启动，现网怎样发布和回退 | [运行与部署](DEPLOYMENT.md) · [独立沙箱](sandbox-deployment.md) |
| 如何验证一次实验真的运行过 | [Notebook 验收](notebook-acceptance.md) · [内容审计](content-audit.md) |

## 基线与验收

2026 年 11 月 18 日核对的线上版本是 Sites 第 5 版，源码提交为 `d0fa0881e575f37fbbcf8b0d49f3f0d75b07aede`。补齐课程原稿、设计材料与维护说明后的本地完整归档提交是 `a3268fa0902fcddee8a3503689e33b1ffdd981d2`，共有 1,145 个跟踪文件。GitHub 上的迁移和文档提交可以晚于该线上版本。维护者发布新版本后，请在这里更新对应关系。

可以先用同一道题检查阅读、计算和进度是否接通。选择“4 句”，运行原版代码，应从真实 Python 得到 3/6；查看预测对照，打开代码，修改后重跑，在学习记录中返回该单元。调整阅读字号或切换单页后，应能回到原来的题目。第一章预测页有可分享的稳定地址。[打开线上实验](https://ai-book-laboratory.lucien-alvarez748774.chatgpt.site/?chapter=upper-01#upper-01-predict-first-patch)

## 先接哪一项工作

1. **自托管运行服务。** 浏览器可执行 34 个实验。容器版已在独立运行机通过真实双访客、双账号及同章 Linux 沙箱隔离验收。将容器部署到自己的服务器时，先确认宿主支持 gVisor 和资源限制，再用两个未登录的浏览器验收同章跨单元运行、不同访客隔离，并验证启用的模型课件。使用自建账号的读者还可跨设备打开该账号的记录。原 Sites 的运行服务需单独接入。[容器部署与运行记录](CONTAINERS.md)
2. **部署交接。** 本地克隆可以开发和构建。发布到原站需要该 Sites 项目的发布权限、原有 D1 绑定和各项服务端配置。先验收浏览器实验，再单独用有权限的测试用户验证真实导读和账号保存。
3. **课程素材。** 第 05 章第二段视频保留了可恢复的约 109 秒，并附末段补读。若取得更完整的原片，保留阅读锚点并同步更新字幕、文字稿和媒体清单。
## 查原始提交

日常开发使用 `main`。GitHub 的[历史归档](https://github.com/Userwei0418/zero-to-ai-book/tree/archive/site-history)保存了原始提交增量。[公开原稿快照](https://github.com/Userwei0418/zero-to-ai-book/tree/archive/source-snapshot)保存迁移时的 1,144 个公开文件。普通克隆可以恢复截至线上 v5 的全部 17 个原始网站提交。

```sh
python3 scripts/restore-original-history.py
git log --oneline course-history
```

脚本校验归档 SHA-256 和完整提交链，创建本地 `course-history` 分支。浅克隆或单分支克隆可先执行以下命令。

```sh
git fetch origin refs/heads/archive/source-snapshot:refs/remotes/origin/archive/source-snapshot refs/heads/archive/site-history:refs/remotes/origin/archive/site-history
```

### 作者如何在本地恢复第 18 次提交

第 18 次提交整理了作者材料，其中多出一份旧版课程附件。它含 1,631 个文件，包括章节代码快照、运行日志和一个小模型权重文件。公开原稿已经重建出相同的 39 篇章节，实验下载包也逐字节一致。日常维护、改课和发布继续使用公开仓库的 `main`。

如果要复查旧实验的原始现场，在公开仓库根目录运行下面的命令。把附件路径换成自己保管的原件，选一个尚未创建、位于公开工作树以外的目录。该目录的上一级需要已存在。

```sh
python3 scripts/restore-original-history.py \
  --private-companion "/path/to/mygpt-companion-20261117-r4-8c90a8fb.zip" \
  --destination ../zero-to-ai-book-author
git -C ../zero-to-ai-book-author rev-list --count HEAD
git -C ../zero-to-ai-book-author rev-parse HEAD
```

输出应为 `18` 和 `a3268fa0902fcddee8a3503689e33b1ffdd981d2`。恢复程序校验附件、文件树与历史归档，在新目录建立独立的 Git 仓库。这个仓库没有远端，原先的公开工作树与分支保留原状。原始归档早于新增的交接文档，现行部署步骤见[运行与部署](DEPLOYMENT.md)。

普通克隆已经包含所需的公开归档分支。单分支克隆可先运行以下命令获取归档，再离线执行上面的恢复步骤。

```sh
git fetch origin refs/heads/archive/source-snapshot:refs/remotes/origin/archive/source-snapshot refs/heads/archive/original-history:refs/remotes/origin/archive/original-history
```

## 怎样把项目上下文持续留下来

每次有影响使用方式的改动，在同一提交中记录当时的问题、采用的做法和能复现的验收步骤。新增或变更部署依赖时，同步记录环境变量名、绑定、迁移顺序及回退办法；实际值由环境单独提供。交接时记录具体提交、已跑过的检查、仍缺少的外部条件。新开发者可以根据这些证据判断当前实现，而无需重读一整串对话。
