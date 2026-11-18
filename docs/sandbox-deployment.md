# Linux 实验沙箱部署与接口

**交付状态：实现和单元验证已完成；尚未部署。** 当前开发环境没有 Docker、gVisor 或目标服务器 SSH，因此没有执行镜像构建、真实容器端到端测试、TLS 上线或 GPU 验证。下面的操作由具备目标 Linux 服务器访问权的部署者完成；不能把前端预览可用视为 Linux 沙箱已接通。

实现位于 `services/sandbox/`。网关只用 Python 标准库和 Docker CLI，不增加主网站依赖，不创建云资源。默认不调用外部模型；部署者显式配置模型凭据后，限定的课程模型请求会真实调用配置的提供方，并可能按该账户套餐计费。所有用户代码只能进入强制使用 `runsc` 的容器；缺少 Docker、gVisor、内存/CPU/PID cgroup 能力或本地镜像时网关拒绝启动，没有宿主 Python 执行降级。

## 架构与身份边界

浏览器向主网站的同源服务端提交课程代码；网站服务端验证用户身份、章节和输入，派生 `sessionKey`，再携带 `Authorization: Bearer <secret>` 调用外部 HTTPS 网关。浏览器不得直接调用此网关，也不得得到 Bearer secret。网关默认且仅允许监听 `127.0.0.1`（或 `::1`），由 HTTPS 反向代理暴露；不返回 CORS 允许头。

主网站必须从已验证的登录用户 ID 或服务端签名的匿名会话 ID 派生 `sessionKey`，例如服务端 HMAC 的十六进制值；不得直接信任浏览器传入的任意用户标识。网关使用 `SHA256(sessionKey + NUL + chapterId)` 定位会话；用户与章节分别隔离。不要将手机号、邮箱或课程代码放入标识。主网站执行入口还应有用户级速率限制与同源/CSRF 检查。

每个会话对应一个独立容器和持久 Python 内核。`globals()`、导入状态和 `/workspace` 文件在连续执行间保留；支持多个文件、普通 Python import、Linux `subprocess` 和 `fcntl`。Python 自身的模块缓存规则仍然生效：修改已经导入的模块后，应显式 `importlib.reload()` 或重置会话。

服务只支持单个网关进程拥有一个 deployment ID，不要用多进程 worker 或无粘性的多副本共享该 ID。需要扩容时先增加上层会话路由、独立 deployment ID 与容量调度；不能直接把当前服务放到随机负载均衡后面。

## 安全与资源上限

| 边界 | 当前实现 |
| --- | --- |
| 容器运行时 | 每次启动显式 `--runtime=runsc`；启动前检查已注册 runtime；不允许 runc 降级 |
| 主机访问 | 不挂载宿主目录、Docker socket、设备或凭据；用户脚本不进入宿主 shell 命令 |
| 权限 | UID/GID 10001、全部 capabilities 移除、`no-new-privileges` |
| 网络 | `--network=none`；不能联网下载数据、调用任意 API 或安装网络包；可选固定模型请求经内核 RPC 交给宿主代理 |
| 根目录 | 只读；`/workspace` 为 64 MiB tmpfs，`/tmp` 为 16 MiB tmpfs；均为 `nosuid,nodev,noexec` |
| CPU / 内存 | 每会话 1 CPU、256 MiB，memory-swap 与 memory 相同；必须有对应 cgroup 能力 |
| 进程 / 文件描述符 | PID 上限 64、nproc 64、nofile 128、禁止 core dump；`/dev/shm` 16 MiB |
| 单次运行 | 默认 15 秒，可配置 1–60 秒；包括冷启动、模型调用及代码执行，冷启动自身最多 20 秒；销毁清理可能额外需要数秒 |
| 输出 | stdout、stderr 各最多 64 KiB，超出部分丢弃并标注；原生 fd 和子进程输出也受限 |
| 图片 | 最多 3 张 PNG，每张最多 512 KiB；使用 Matplotlib Agg，无 GUI |
| 请求 | 256 KiB HTTP body，代码 64 KiB UTF-8，总文件文本 128 KiB，最多 32 个文件 |
| 单个上传文件 | 64 KiB；仅允许安全相对路径；最多 8 层、240 字符；拒绝越界、符号链接、硬链接和非普通文件 |
| 会话 / 并发 | 默认最多 12 个会话、4 个并发执行、24 个 HTTP 请求线程；同一会话只允许一次执行 |
| 频率 | 全网关每分钟 600 次已鉴权请求；每用户章节每分钟 60 次工作请求；另有 60 次 reset/interrupt 控制额度 |
| HTTP 读取 | 请求头和正文总计 10 秒截止；拒绝 chunked body 与重复 Content-Length/Authorization |
| 闲置回收 | 默认 15 分钟，约每 10 秒检查；只回收未执行的会话 |

`noexec` 表示不能把新上传的二进制或脚本直接作为可执行文件启动；可用 `python script.py`、`sh script.sh` 或系统已有程序。课件不应依赖 root 权限、Docker in Docker、网络、图形桌面、宿主文件、任意系统调用或 GPU。gVisor 提供 Linux 系统调用兼容层，不等于所有 Linux 内核功能都兼容。

超时、手动中断、内核退出、协议错误或内存不足会销毁该会话；变量和临时文件不再存在，下次运行创建新会话且执行计数从 1 开始。闲置回收、服务重启也会清空状态。请让网页明确提示“会话已重置，需重新运行前置单元”。正常 Python 异常返回 `error`，不会主动清空已有变量。

若容器销毁无法确认，网关停止接受新执行并返回 unavailable，不能无限创建替代容器。重启时清理本 deployment ID 的遗留容器。运维应监控失败并检查 Docker daemon；不得绕开隔离检查。

网关账户有 Docker socket 访问权，等同于高主机权限，因此应运行在专用、及时更新的执行主机。不能把该账户或 socket 暴露给 guest。Python 内核不是安全边界：安全边界是 gVisor、容器限制和鉴权网关；guest 协议数据仍由网关校验、限额并去掉自报的执行计数。

## 部署步骤

### 1. 准备专用 Linux 主机与 gVisor

安装受支持的 Docker Engine、Python 3.10+、Caddy（或其他 HTTPS 反向代理），按 [gVisor 官方安装说明](https://gvisor.dev/docs/user_guide/install/) 安装 `runsc`。新版发行物可能包含 `gvisor-bin/` 配套目录，需保持官方要求的目录结构。按官方说明注册 runtime：

```bash
sudo /usr/local/bin/runsc install
sudo systemctl reload docker
docker run --rm --runtime=runsc hello-world
docker info --format '{{json .}}'
```

确认 Docker info 中存在 `Runtimes.runsc`，以及 `MemoryLimit`、`SwapLimit`、`PidsLimit`、`CpuCfsQuota`、`CpuCfsPeriod` 均为 `true`。不能通过删除检查或改用默认 runtime 来“修复”启动失败。运维必须确认 `runsc` 注册项确实指向 gVisor，并完成官方生产环境加固。

此步骤会在目标主机安装软件、配置 Docker 并拉取测试镜像；本项目没有替部署者执行这些操作。资源限制语义可参照 [Docker 官方容器运行说明](https://docs.docker.com/engine/containers/run/)。

### 2. 构建固定依赖镜像

在项目根目录运行：

```bash
docker build --tag ai-book-sandbox:1 services/sandbox
docker image inspect ai-book-sandbox:1
```

镜像预装固定版本 NumPy、Pandas、Matplotlib，清单位于 `requirements.txt`。只有部署者在镜像构建阶段安装依赖；网关绝不会对用户提交的 requirements 执行宿主 pip。新增依赖应审查后重建镜像。生产部署应使用审计过的基础镜像 digest，例如构建时传入 `--build-arg PYTHON_IMAGE=python@sha256:<已核验摘要>`，并在 `SANDBOX_IMAGE` 配置最终的不可变镜像摘要；此处不提供未经验证的 digest。

默认镜像名称使用本地标签，网关运行时设置 `--pull=never`，不会因为用户提交代码而联网拉取镜像。

### 3. 安装网关和保护 secret

将 `services/sandbox/` 的网关 Python 文件复制到 root 所有且不可由网关账户写入的 `/opt/ai-book-sandbox/`。创建专用系统账户，给予该账户 Docker 访问权限：

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin sandbox-gateway
sudo usermod --append --groups docker sandbox-gateway
sudo install -d -m 0755 /opt/ai-book-sandbox
sudo install -m 0644 services/sandbox/gateway.py services/sandbox/model_broker.py services/sandbox/validation.py /opt/ai-book-sandbox/
sudo install -d -m 0700 /etc/ai-book-sandbox
sudo install -m 0600 services/sandbox/sandbox.env.example /etc/ai-book-sandbox/sandbox.env
python3 -c 'import secrets; print(secrets.token_urlsafe(48))'
```

将生成的随机值填入 `/etc/ai-book-sandbox/sandbox.env` 的 `SANDBOX_TOKEN`；示例 `CHANGE_ME` 会被程序拒绝。不要把真实 token 提交到代码仓库、截图、前端环境变量或共享终端日志中。可改用 `SANDBOX_TOKEN_FILE`，但文件需要网关账户可读且仅允许预期账户访问；该设置优先于 token 环境变量。

配置参数见 `sandbox.env.example`。网站服务端用 `SANDBOX_API_KEY` 保存同一个 secret，用 `SANDBOX_API_URL` 设置 HTTPS 网关根 URL。不可使用 `NEXT_PUBLIC_` 等会进入浏览器包的变量名。网站的模型配置不会自动传到独立 Linux 主机；要运行模型课件，还需要按下节在沙箱宿主单独配置 TOKENPLAN 变量。

安装并启动 systemd unit：

```bash
sudo install -m 0644 services/sandbox/ai-book-sandbox.service /etc/systemd/system/ai-book-sandbox.service
sudo systemctl daemon-reload
sudo systemctl enable --now ai-book-sandbox
sudo systemctl status ai-book-sandbox
```

只运行一个实例。变更 deployment ID 会改变遗留容器的清理范围；旧 deployment 的容器需运维单独清理。systemd unit 使用环境文件加载 token、禁止网关写入系统目录，并在退出时要求清理会话。主机仍必须有足够的实际内存和 CPU 容量支持配置的会话数。

### 4. 接入 HTTPS

把 `services/sandbox/Caddyfile.example` 的域名替换成实际沙箱域名并合并到 Caddy 配置，配置域名 DNS，开放必要的 80/443 端口。Caddy 自动签发证书需要这些外部条件；本项目没有创建 DNS、证书或服务器。

网关端口 8090 只绑定 loopback，不应对公网开放。反向代理需保留 Authorization，最大请求体至少与网关的 256 KiB 相符，响应超时至少 90 秒以覆盖启动、执行和清理。不得在 access log 中记录 Authorization 或请求 body。可额外限制主网站服务端的来源网络，但不要误封动态出口而误判为沙箱故障。

### 5. 验收后再在网页启用 Linux 按钮

不需要 Docker 的测试：

```bash
python3 -m unittest discover -s services/sandbox/tests -v
python3 -m py_compile services/sandbox/gateway.py services/sandbox/kernel.py services/sandbox/validation.py services/sandbox/guest_model.py services/sandbox/model_broker.py services/sandbox/smoke_test.py
```

目标服务已经上线后，使用当前 shell 的安全 secret 注入方式设置 `SANDBOX_TOKEN` 和 `SANDBOX_URL=https://实际域名`，运行：

```bash
python3 services/sandbox/smoke_test.py
```

验收脚本仅把固定测试代码通过 HTTP 发给真实网关，不在宿主执行课件。它验证变量和文件保留、多文件 import、子进程、fcntl、非 root UID、PNG、输出截断、无限循环超时后的重建，以及并发中断。脚本会使用独立随机测试会话，最后重置清理；本次交付未运行此脚本。

上线验收还应检查：错误 token 返回 401；不同用户与章节不能看到另一会话的变量；`docker inspect` 中 runtime 为 runsc，所有限额正确；guest 看不到 docker.sock；容器无法访问网络、修改只读根目录；内存/PID压力触发限额而不影响主机；闲置与服务重启后遗留容器得到清理。实际运行时间、兼容性和机器容量必须在目标主机测量，单元测试不能替代这些检查。

## HTTP 协议

全部端点使用 `POST`、`Content-Type: application/json`、`Authorization: Bearer <secret>` 和单一 Content-Length。`sessionKey`、`chapterId`、`cellId` 均为 1–128 个英文字母、数字、下划线或连字符。不要将浏览器的用户身份字段直接转发。

| 端点 | 请求 | 行为 |
| --- | --- | --- |
| `/execute` | `sessionKey, chapterId, cellId, code, files?` | 创建或复用当前用户章节内核，写入可选文件，执行一次 |
| `/status` | `sessionKey, chapterId` | 不创建会话；返回是否存在、idle/busy、计数、`runtime: "gvisor"`、`gpu: false`、`modelConfigured`、`modelStreaming: "buffered"` |
| `/reset` | `sessionKey, chapterId` | 销毁会话和文件；返回 idle、exists=false、计数 0 |
| `/interrupt` | `sessionKey, chapterId` | 销毁当前会话以终止代码；返回 interrupted、exists=false；即使闲置也会销毁会话 |

执行请求示例：

```json
{
  "sessionKey": "server_derived_opaque_user_id",
  "chapterId": "linux-files",
  "cellId": "cell-2",
  "code": "from helper import double\nprint(double(21))",
  "files": {"helper.py": "def double(x):\n    return x * 2\n"}
}
```

`files` 也兼容 `[{"path":"helper.py","content":"..."}]`；仅 UTF-8 文本。未提供的文件仍然保留，空映射不会清空工作目录。不会自动安装依赖。

执行响应示例：

```json
{
  "status": "ok",
  "stdout": "42\n",
  "stderr": "",
  "images": [],
  "executionCount": 2,
  "elapsedMs": 12,
  "sessionLost": false
}
```

有图片时每项为 `{"mimeType":"image/png","data":"<不含data URL前缀的base64>"}`。网站应按 PNG 展示，不能将输出当 HTML 插入页面。代码最后一个表达式的非 None 值会显示为 `repr`；普通代码不会显示 Python 语句的返回值。执行计数和 elapsedMs 由网关生成，guest 无法修改这些字段。

| 情况 | HTTP | `status` / 附加信息 |
| --- | --- | --- |
| 执行完成 | 200 | `ok` |
| Python 异常 | 200 | `error`，`error: {type,message}`，stderr traceback；保留会话 |
| 执行超时 | 200 | `timeout`，`sessionLost: true`；下一次创建全新会话 |
| 正在执行被 reset/interrupt 终止 | 200 | 原执行返回 `interrupted`、`sessionLost: true` |
| 无凭据或凭据错误 | 401 | `error` |
| 非法 JSON、路径、字段 | 400 | `error` |
| 输入过大 / Content-Type 错误 | 413 / 415 | `error` |
| 同会话已有执行 | 409 | `busy` |
| 速率或容量已满 | 429 | `busy`；HTTP 线程入口满时返回空 body 的 503 |
| 启动、内核退出、Docker、清理等服务故障 | 503 | `unavailable`；若现有状态丢失则 `sessionLost: true` |

`/status` 没有会话时为 `idle, exists:false`，并不意味着已有变量可继续使用。执行请求与 `/interrupt` 必须允许同时发出，主网站不能以同一个互斥锁阻塞中断请求。一次运行从成功提交内核起计数，错误代码也占一次；容器启动失败可能仍为 0。状态轮询建议不超过每 2 秒一次。

## 可选真实模型代理

课件使用 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 和 `urllib.request.urlopen()`。容器仍然没有外部网络；内核在容器 loopback `127.0.0.1:8765` 提供兼容 urllib 的本地 HTTP 入口，再通过隔离的 stdin/stdout JSON 协议向宿主发送模型 RPC。这同时支持内核内代码和通过 subprocess 启动的 Python 脚本。端口只存在于各自容器，不映射到宿主。

在沙箱主机的受保护环境文件中配置：

```ini
TOKENPLAN_API_KEY=<真实提供方密钥，仅宿主持有>
TOKENPLAN_BASE_URL=https://token.sensetime.com/api/v1
TOKENPLAN_MODEL=sensenova-6.8-flash
SANDBOX_MODEL_TIMEOUT_SECONDS=25
SANDBOX_MODEL_CALLS_PER_EXECUTION=12
# 模型多次调用课件可显式提高整个cell预算，最大60秒：
SANDBOX_TIMEOUT_SECONDS=60
```

上述服务地址和模型名为配置示例，是否对当前账户开放需要真实提供方验证。密钥不进入镜像、容器环境、RPC 请求或网页。guest 得到的 `LLM_API_KEY=sandbox-broker` 只是本地占位值，`LLM_BASE_URL=http://127.0.0.1:8765/v1`，以及允许的模型名。不要把文档中的真实服务端 secret 复制到课件环境。

宿主只允许 `POST /v1/chat/completions`，固定转发到运维配置的 HTTPS 服务前缀与固定模型；不会接受用户指定的 URL、Authorization、服务主机或重定向。模型 RPC 和普通 stdout 分流，所有 RPC 仍按不可信 guest 数据处理；即使用户伪造 RPC，也只能申请这一受限操作，不能变成宿主网络代理。未配置 key 明确返回 503；不生成模拟回答。提供方返回的 JSON / SSE 内容来自真实响应，不改写成预设答案；若上游意外回显宿主密钥，会对该精确字符串脱敏。

| 模型代理边界 | 限制 |
| --- | --- |
| 请求类型 | 仅文本 Chat Completions；允许标准 tool calling JSON；最多 100 条 messages、16 个工具定义 |
| 模型与输出预算 | 只允许配置模型；每次 n=1；默认 max_tokens=1024，显式上限 2048 |
| 输入 / 输出 | 模型请求 64 KiB，提供方响应 512 KiB；不支持任意文件、图片 URL 或音视频负载 |
| 调用额度 | 默认每 cell 最多 12 次，可配 1–32；每用户章节每小时 120 次，全局每分钟 120 次；重置会话不重置后两项内存额度 |
| 并发与超时 | 全局最多 2 个提供方请求；默认单次 25 秒，可配 1–45 秒；所有调用仍计入整个 cell 的 15–60 秒总预算 |
| 流式行为 | `stream:true` 的真实 SSE 会先限额缓冲，再按原内容返回；**不支持实时逐 token 传输**，不能拿此环境测真实首 token 延迟 |

无配置、额度不足或提供方失败会在课件中表现为 HTTPError，而非成功回复；单元测试只验证代理机制，并没有调用真实提供方。`/status.modelConfigured=true` 仅代表已配置 key，不代表密钥有效或提供方健康。访问本地 `/v1` 的连通性探针只检查本地代理，不证明外部模型可达。

目前不代理 `/embeddings`、`/rerank`、语音、图像、任意其他 URL，相关课程的纯本地 fallback 仍可运行；需要这些外部能力时应另加明确、固定的操作适配器和配额，不能开放任意 URL 转发。大量评测、批量调用或长上下文完整脚本可能触发当前时间、调用次数或文本容量限制，应拆分实验或由运维审查后调整允许的预算。已被提供方接受的请求在本地中断后仍可能计费，不能承诺远端撤销。

在已配置真实提供方、确认允许真实调用后，设置 `SANDBOX_SMOKE_MODEL=1` 再执行 smoke_test.py，将额外通过容器测试一次非流式调用、一次缓冲 SSE 调用以及一次子进程调用。这是显式启用的付费可能操作，默认验收脚本不会调用模型。

## GPU 与后续接入点

**GPU 当前未接入，也不由本服务支持。** 不要显示 GPU 已可用，不要向本 Docker 命令偷偷加入 `--gpus` 或切换 runc。GPU 课程需要另外选择兼容的隔离执行提供方、设备驱动、配额、费用和会话生命周期方案，并在主网站的执行提供方适配层明确路由；secret 仍只放在服务器。

建议该独立 GPU 提供方复用相同 execute/reset/interrupt/status 语义，并在 `/status` 增加真实能力信息。只有目标提供方部署、权限和验收都完成后，网页才可把 GPU 课程标为可执行。当前源码不会自动开通云服务或购买 GPU。

## 本次实际验证记录

- 51 项标准库单元测试已通过：常量时间鉴权、UTF-8 大小、输入/path/文件数量限制、两种 files 格式、符号链接/硬链接/FIFO 防护、用户章节隔离键、速率与并发限制、超时销毁、清理失败关闭、Docker 参数、缺 runsc/cgroup 关闭、HTTP 契约、guest 输出与图片校验；另含模型固定目标/模型校验、无key拒绝、禁止重定向、额度、SSE缓冲、secret隔离与脱敏、RPC调度和本地urllib接口。
- `py_compile` 对网关、内核、验证层、宿主/guest模型代理和验收脚本全部通过。
- 当前开发环境未找到 Docker；镜像未构建、gVisor 未启动、真实 Python 会话/图片/中断端到端未运行。
- 未连接真实模型提供方、部署服务器、HTTPS 或 GPU；文中的示例域名、secret 和镜像摘要均需部署者填写真实值。
