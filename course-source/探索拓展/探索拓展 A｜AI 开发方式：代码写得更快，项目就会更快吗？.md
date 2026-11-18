---
source: https://sensetime.feishu.cn/wiki/H4QvwZOB2ipXrjk1HasclV2Knrc
fetched: 2026-11-16 15:14:53 (Asia/Shanghai)
revision: 8
---

# 探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？

*附录｜探索拓展。主线讲 AI 自己怎么走到今天。附录换一个维度：看它走进一个个行当以后，那个行当的干法是怎么一年一个样的。软件开发是其中一条支线，也是变得最快的一条。这一篇可以单独读，结尾接回第 14 章的验收。*

## 同一件小事，六种姿势

请你先回想一下：你第一次让 AI 帮你写代码，是什么姿势？

是在编辑器里敲到一半，后面冒出一行灰色的字？是把一段报错贴进聊天框？还是在终端里敲下一句话，然后看着它自己改了十几个文件？

你的答案，大致能说出你是哪一年开始的。

这一篇从头到尾只办一件小事。第 14 章留下了一个小工具 `accept.py`，五十来行。组长提了个要求：能不能把检查结果导出成一张表，他好贴进周报里。

同一件事，我们按这五六年的顺序，换六种姿势各做一遍。有的姿势手边复现得了，就真做。复现不了的，就老实讲它当年是什么样。

## 第一站：编辑器里的灰字

2021 年 6 月 29 日，GitHub 放出了 Copilot 的技术预览版，装在 VS Code 里。发布文章的标题管它叫“AI 结对程序员”。

请留意这个日子。它比 ChatGPT 早了将近一年半。

那时候的它不会聊天。你在编辑器里写着，它在光标后面用灰色的字猜你接下来要写什么。你按一下 Tab，灰字就变成了真的。它背后的模型叫 Codex，是 GPT-3 为代码改出来的一个版本。

这就是第 04 章的那件事：学着接下一句。只是接的是代码。

我们来模仿一下。把 `accept.py` 整个摆在前面，在末尾起一个函数的头，然后不许它说话，只许它往下续几行。

```python
# ghost.py：模仿 2021 年编辑器里的那行灰字。不许它对话，只许它接着光标往下续几行
from llm import chat

OLD = open("accept.py", encoding="utf-8").read()
CURSOR = OLD.rstrip() + '\n\n\ndef export_csv(path):\n    """把那九份东西的检查结果导出成一个 CSV 文件"""\n'

for n in (1, 2, 3):
    more = chat("下面是一个 Python 文件，光标停在最后一行的后面。请只输出接下来该写的代码，最多六行，"
                "不要解释，不要重复已有的内容，不要用代码块包起来。\n\n" + CURSOR)
    print(f"第 {n} 遍，它续的是：")
    for line in more.strip("`\n").split("\n")[:6]:
        print("    " + line)
```

```
第 1 遍，它续的是：
    from cases import CASES
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write("文件,毛病\n")
            for n, (material, fault, words) in enumerate(CASES, 1):
                problems = check_text(material)
                f.write(f"第{n}份,{';'.join(problems) if problems else '无'}\n")
第 2 遍，它续的是：
    from cases import CASES
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write("文件,毛病\n")
            for n, (material, fault, words) in enumerate(CASES, 1):
                problems = check_text(material)
                f.write(f"第{n}份,{';'.join(problems)}\n")
第 3 遍，它续的是：
    from cases import CASES
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write("文件,毛病\n")
            for n, (material, fault, words) in enumerate(CASES, 1):
                problems = check_text(material)
                f.write(f"第{n}份,{';'.join(problems) if problems else '无'}\n")
```

续得有模有样。打开文件，写表头，一份一份地查，写进去。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/XXm2bD1cvoIxXhxohLmcEtQdnOd.png|你敲到一半，后面冒出一行灰色的字。]]

请看它写的表头：“文件,毛病”。两栏。组长要的是三栏：编号，毛病数，毛病。

这一站的好处和限度都在这几行里。好处是快，你想到一半，它替你把后一半敲了。限度是，方向盘一直在你手里：函数叫什么、放在哪儿、什么时候调用，都得你先起个头。它看得见的只有光标前后那一片，它不知道组长是谁。

2022 年 6 月，Copilot 结束预览，开始收费。那一年，“让 AI 写代码”指的就是这个：一行灰字。

## 第二站：聊天框，和一个搬运工

2022 年底，ChatGPT 来了。写代码的人很快发现了一种新姿势：把整个文件贴进去，说一句人话。

它吐出一个新文件。你复制回来，存上，跑一下。报错了，把报错再贴回去。

这一站我们能原样复现。贴进去，说一句“加一个导出 CSV 的功能”，拿回来就用。试三遍。

```
直接说 第 1 遍：改了 1 回，9 秒，2136 个 token。旧功能坏了 0 条，新功能没过 2 条
直接说 第 2 遍：改了 1 回，9 秒，2123 个 token。旧功能坏了 0 条，新功能没过 2 条
直接说 第 3 遍：改了 1 回，9 秒，2123 个 token。旧功能坏了 0 条，新功能没过 2 条
```

九秒钟。比上一站强多了：不用你起头，它一口气给了一个完整的、能跑的新文件。旧功能一条没坏。

“新功能没过 2 条”是什么？打开三遍各自导出的表，看表头：

```
第 1 遍：序号, 预期结果, 实际检查结果, 是否通过
第 2 遍：序号, 预期结果, 实际拦截数, 检查结果
第 3 遍：序号, 预期结果, 实际拦截数, 检查结果
```

还是那个毛病。你没告诉它表头，它就替你定了，每一遍定得还不一样。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/C0nCbOjLGomKebxfObUcuTddnYf.png|你在聊天框和项目之间来回搬。]]

这一站里最累的那个角色，是你。

你是搬运工。文件是你搬进去的，结果是你搬回来的，报错是你搬过去的。它看得见的，只有你搬给它的那些。项目里另外四十个文件长什么样，测试过没过，它一概不知道。项目一大，光是决定“这一回该搬哪几个文件给它看”，就成了一门手艺。

## 第三站：把对话搬进编辑器

搬运这件事，显然该让机器自己干。

2022 年，四个还在麻省理工念书的学生办了一家公司，后来做出了一个叫 Cursor 的编辑器。它的想法很直接：既然活儿在编辑器里，就把那个会对话的模型也请进编辑器里。它自己看得见整个项目，要哪个文件自己去翻。它提出的修改，直接标在你的代码上，红的是删，绿的是添，你点头才算数。

老牌的那一边也在做同样的事。到 2023 年，Copilot 里也有了对话。

这一站我们手边复现不了，它需要一个真的编辑器。可是它解决了什么，你已经知道了：你不再是搬运工。你说“把这个函数的名字改掉”，它跨着十几个文件一处一处改，每一处等你点头。

它没解决的，也请你想一想。

改完以后，测试是谁跑的？还是你。跑出来红了，是谁把那一屏红字念给它听的？还是你。它每走一步，都在等你。

## 第四站：有人喊出了“AI 工程师”

要是让它自己跑测试、自己看报错、自己再改呢？

你认得这个想法。这是第 09 章的那个圈。

2023 年 10 月，几位研究者为这个想法备了一张考卷，叫 SWE-bench：从 12 个常用的 Python 开源项目里，找出 2294 个真实的问题单，连同当初修好它的那次提交。考法是把问题单和整个代码仓库交给模型，看它改出来的代码过不过得了项目自己的测试。

当时最好的模型，解出了 1.96%。

一百道题，做对两道。

2024 年 3 月，一家只有十个人的创业公司 Cognition 发布了 Devin，报道里管它叫“第一个 AI 软件工程师”：给它一件开发任务，它自己从头做到尾。报道铺天盖地。没过多久，就有做视频的程序员指出，它并没有做成演示里要它做的事。

这一站很像第 09 章开头的那个春天。想法是对的，圈也转起来了。它转出来的东西靠不靠得住，那时候谁也说不准。

这一站留下来的，是那张考卷的考法：别看演示，把它扔进一个真的仓库，让项目自己的测试来判。

## 第五站：回到终端

2025 年，事情拐了一个让很多人意外的弯。

走在最前面的工具，没有做出一个更花哨的编辑器。它们回到了程序员最老的那个地方：一个黑底的窗口，一个闪着的光标。

2 月，Anthropic 放出了 Claude Code，一个在终端里用人话派活的命令行工具，5 月正式发布。4 月 16 日，OpenAI 开源了 Codex CLI，同样跑在你自己的终端里。CLI 是“命令行界面”的缩写：没有按钮，没有菜单，你敲一行字，它回几行字。

为什么是终端？

请想一想程序员平时在终端里干什么。跑测试是一条命令。看改了哪些文件是一条命令。装依赖、提交代码、把程序发上线，都是一条命令。几十年来，这一行所有的工具，早就都学会了“一行字进，几行字出”。

而模型最拿手的，恰好就是读字和写字。

第 08 章给了它一双手，那时候每一样工具都要你专门替它做。到了终端里，这件事倒过来了：你能敲的命令，它都能敲。整个开发环境，现成地成了它的工具箱。

我们做一个最小的。给它一个文件夹，四样工具：看看有哪些文件，读一个文件，写一个文件，跑测试。吩咐还是开头那一句，一个字不加。

```python
# mini.py：一个住在终端里的小 Agent。给它一个文件夹、几样工具，和开头那句一模一样的吩咐。你不用再搬任何东西
# 用法：python3 mini.py 读写        只给两样工具：读文件、写文件
#       python3 mini.py 读写跑      再给一样：跑测试
import json, os, shutil, subprocess, sys
from llm import chat, SPENT

ASK = ("这个文件夹里有一个正在用的小工具 accept.py。请给它加一个导出功能："
       "运行 python3 accept.py --csv 文件名 的时候，把那九份东西的检查结果导出成一个 CSV 文件。改完告诉我一声。")

def spec(tool, about, **args):
    return {"type": "function", "function": {"name": tool, "description": about, "parameters": {
        "type": "object", "properties": {k: {"type": "string", "description": v} for k, v in args.items()},
        "required": list(args)}}}

TOOLS = [spec("list_files", "列出文件夹里有哪些文件"),
         spec("read_file", "读一个文件的全文", name="文件名"),
         spec("write_file", "把一个文件整个写成新的内容", name="文件名", content="完整的新内容"),
         spec("run_tests", "运行 python3 tests.py accept.py，交回测试结果")]

def act(folder, call, tried):
    """替它动手。它只管说要什么，真正碰文件、跑命令的是这里"""
    name, args = call["function"]["name"], json.loads(call["function"]["arguments"] or "{}")
    path = os.path.join(folder, os.path.basename(args.get("name", "")))
    if name == "list_files":
        return "、".join(sorted(f for f in os.listdir(folder) if not f.startswith("_")))
    if name == "read_file":
        return open(path, encoding="utf-8").read() if os.path.isfile(path) else "没有这个文件"
    if name == "write_file":
        if os.path.basename(path) == "tests.py":
            tried.append("想改 tests.py")
            return "不行。tests.py 是用来量你的，你不能改它"
        open(path, "w", encoding="utf-8").write(args["content"])
        return "写好了"
    if name == "run_tests":
        done = subprocess.run([sys.executable, "tests.py", "accept.py"], cwd=folder, capture_output=True, text=True, timeout=120)
        return (done.stdout + done.stderr[-300:]).strip()
    return "没有这样工具"

def work(folder, tools, most=12):
    """那个圈：它要工具就替它办，把结果递回去；它不再要工具、开口说话，就算它认为做完了"""
    messages, used, tried = [{"role": "user", "content": ASK}], [], []
    for _ in range(most):
        message = chat(messages, tools=tools)
        messages.append(message)
        calls = message.get("tool_calls") or []
        if not calls:
            return used, tried, (message.get("content") or "").strip()
        for call in calls:
            result = act(folder, call, tried)
            target = json.loads(call["function"]["arguments"] or "{}").get("name")
            used.append(call["function"]["name"] + (f"({target})" if target else ""))
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": result})
    return used, tried, "（转满了十二圈，它还没说做完）"

if __name__ == "__main__":
    mode = sys.argv[1]
    tools = TOOLS if mode == "读写跑" else TOOLS[:3]
    for n in (1, 2, 3):
        folder = f"work_{mode}_{n}"
        shutil.rmtree(folder, ignore_errors=True); os.mkdir(folder)
        for f in ("accept.py", "docs.py", "cases.py", "tests.py"):
            shutil.copy(f, folder)
        before = SPENT["tokens"]
        used, tried, said = work(folder, tools)
        check = subprocess.run([sys.executable, "tests.py", "accept.py"], cwd=folder, capture_output=True, text=True, timeout=120).stdout
        old, new = check.count("旧功能") + check.count("跑不起来"), check.count("新功能")
        print(f"{mode} 第 {n} 遍：它自己动了 {len(used)} 次手，{SPENT['tokens'] - before} 个 token。旧功能坏了 {old} 条，新功能没过 {new} 条"
              + (f"。{'；'.join(tried)}" if tried else ""))
        print("     " + " → ".join(used))
        open(f"_mini_{mode}_{n}.txt", "w", encoding="utf-8").write(" → ".join(used) + "\n\n它最后说：" + said + "\n\n" + check)
```

先只给前三样，不给“跑测试”。

```
读写 第 1 遍：它自己动了 4 次手，10115 个 token。旧功能坏了 0 条，新功能没过 2 条
     list_files → read_file(accept.py) → read_file(cases.py) → write_file(accept.py)
读写 第 2 遍：它自己动了 4 次手，10002 个 token。旧功能坏了 0 条，新功能没过 2 条
     list_files → read_file(accept.py) → read_file(cases.py) → write_file(accept.py)
读写 第 3 遍：它自己动了 4 次手，9979 个 token。旧功能坏了 0 条，新功能没过 2 条
     list_files → read_file(accept.py) → read_file(cases.py) → write_file(accept.py)
```

你一趟也没搬。它自己看了文件夹，读了 `accept.py`，又去读了 `cases.py`，然后写了回去。

结果和聊天框那一站一样：新功能没过 2 条。表头还是它自己定的。

再把第四样工具给它。

```
读写跑 第 1 遍：它自己动了 6 次手，17636 个 token。旧功能坏了 0 条，新功能没过 0 条
     list_files → read_file(accept.py) → read_file(cases.py) → read_file(tests.py) → write_file(accept.py) → run_tests
读写跑 第 2 遍：它自己动了 7 次手，25071 个 token。旧功能坏了 0 条，新功能没过 0 条
     list_files → read_file(accept.py) → read_file(cases.py) → read_file(tests.py) → read_file(docs.py) → write_file(accept.py) → run_tests
读写跑 第 3 遍：它自己动了 6 次手，17496 个 token。旧功能坏了 0 条，新功能没过 0 条
     list_files → read_file(accept.py) → read_file(cases.py) → read_file(tests.py) → write_file(accept.py) → run_tests
```

三遍，全过。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/WAWZbidxBoaT55xwsHAc2BxjnBe.png|它在敲键盘。你端着杯子在后面看。]]

请对比两段输出里它动手的顺序。多出来的那一步在哪儿？

在写之前。有了“跑测试”这样工具，它先去读了 `tests.py`。测试里写着表头该是“编号,毛病数,毛病”。它照着写，一回就过。

我本来以为会看到的是另一幅画面：它先写错，跑测试，看见红字，再改。它没有走这条路。它知道自己待会儿要被这套测试量，于是先去看了一眼尺子上刻的是什么。

没有“跑测试”的那三遍，`tests.py` 一样躺在文件夹里，它一样读得到。它没去读。

## 套在模型外面的那一层

把三种做法摆在一起。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/VQQXbakadoXLgfxtzficWv59nef.png|同一个模型，同一句吩咐。]]

模型是同一个。那句话是同一句。结果不一样。

变的是什么？是模型外面的那一层：它手里有哪几样工具，那个圈怎么转，什么时候停，什么事要先问你。

这一层有个名字，这两年你会越来越常听到：**harness**。这个词原本指套在马身上的那副挽具。马有力气，挽具决定这股力气往哪儿使、使在什么上。`mini.py` 就是一副最小的 harness，七十来行。Claude Code、Codex CLI 这些工具，去掉模型，剩下的就是一副很大很讲究的 harness。

所以这两年比较这些工具的时候，只问“它背后用的是哪个模型”是不够的。同一个模型，换一副 harness，就是另一个东西。上面那张图，是七十来行代码量出来的。

一副讲究的 harness 里有些什么，你其实都见过了，只是当时没给名字：

- **工具和权限。** 第 08 章的手，和那道要你点头的门。
- **那个圈和刹车。** 第 09 章。
- **规则文件。** 在仓库里放一份写给它看的说明：这个项目怎么跑测试，哪些目录不许碰。眼下通行的一种叫 AGENTS.md，它的主页上说这是“给 Agent 看的 README”，已经有六万多个开源项目在用。
- **装什么进上下文。** 第 11 章的交接包。对话太长了就压成一份摘要再接着干，业内叫 compaction。琢磨“这一回该让它看见什么”的那门手艺，有人叫它上下文工程。
- **计划模式。** 动手之前先让它把打算怎么干写出来，你点了头它才动。
- **钩子（hook）。** 在它每次改文件之前或之后，自动跑一段你写的检查。它管不着这一段。

最后一条值得多说一句。`mini.py` 里有一行很不起眼：它要是想改 `tests.py`，一律回绝。六遍里它一次也没试过。可那一行得在那儿。附录 G 讲过，一个只管把分数弄高的过程，改尺子和改自己，对它来说是一样的路。

## 第六站：派出去

它能在终端里自己干完一件事了。下一步几乎是顺理成章的：那就别只派一件。

2025 年 5 月 16 日，OpenAI 发布了云端的 Codex：你交代一个任务，它在云上给这个任务单独开一个环境，自己干，多数任务要 1 到 30 分钟，干完交回来一份改动等你看。同一个月，GitHub 给 Copilot 加了类似的东西：把一张问题单指派给它，它在云端干完，起草一个合并请求，再叫你来审。10 月，Cursor 发布 2.0，主打的是让好几个 Agent 同时开工。

好几个同时改同一个仓库，不会互相踩吗？办法是每人发一份。程序员用的版本管理工具早就有这个本事，叫 worktree：同一个仓库，另开一份独立的工作副本，各改各的，改完再合。第 12 章的“多请几个助手”，在这儿落到了一条现成的命令上。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/U37FbnBMeo2UVCxd7gfcVrsbnad.png|四个在树上各干各的。你在树下一份一份地看。]]

这一站还有一个方向：把这套东西交给不写代码的人。2026 年 1 月，Anthropic 放出了 Cowork，和 Claude Code 是一路的，换了一个图形界面。2 月，OpenAI 出了 Codex 的桌面应用。

顺便说一句这一站的名字有多不经用。据百科条目记载，那个桌面应用五个月以后就并进了别的应用里，Cowork 单独的入口也在 9 月收了回去。你读到这一页的时候，上面这些名字多半又换过一轮。请别记名字。请记这一站变了的那件事：

**你从写代码的人，变成了派活和收活的人。**

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/EfKVbHiPFoXoqYxfJtYc6RsznHc.png|AI 写代码，这几年换了六种姿势。]]

## 派出去以后，话得说清楚

一次派出去五件事，每一件它都替你定一个表头，回来就是五个你不想要的表头。

交出去得越多，你那句吩咐就越要紧。这两年围着这件事，吵出了两个词。

2025 年 2 月 2 日，安德烈·卡帕西发了一条帖子，给一种写法起了个名字：vibe coding。完全跟着感觉走，忘掉代码的存在。看见报错就整段贴回去，让它自己改，改到能跑为止。

这个词传得飞快。传的过程中，他原帖里的后半句常常被落下：他说这用在周末随手做的、做完就扔的小项目上还不错。

另一头的写法叫规格驱动。2025 年 9 月，GitHub 开源了一套工具，把它分成四步：先写清楚要什么，再定计划，再拆成任务，最后才动手。他们的说法是，从前代码是准绳，现在意图是准绳。

落到我们这个小工具上，“先写清楚要什么”是两样东西。

一样是给旧功能扎一圈篱笆：动手之前，把它现在的行为记下来，一共十二条，往后谁改都不许变。另一样是把新功能的验收写成能跑的检查：有没有生成文件，表头是不是那三栏，是不是九行。

```python
# tests.py：给 accept.py 的一套测试。前十二条守着旧功能，后三条是新功能“导出”的验收
# 用法：python3 tests.py 要测的文件.py
import csv, importlib.util, os, subprocess, sys
os.environ["LIBRARY"] = "上周的"                          # 这些测试都按 D15 发布之前的资料库来

def load(path):
    spec = importlib.util.spec_from_file_location("target", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

OLD = [  # 旧功能：九份东西，各该查出什么
    [], [], [], ["拿已废止的 D02 当依据"], [], [], [], [], ["这一条没写依据：周末也可以预订。"]]
EXTRA = [  # 第 14 章修过的三处，容易被改坏
    ("# 报销\n\n- 提交时限：十个工作日内。\n- 依据：资料 D12（现行规定）。", []),
    ("# 推算\n\n## 前提\n- 早上 9:00 提交。\n\n## 推算\n- 审批 45 分钟。依据 D03", []),
    ("# 报销\n- 须在返回后 20 个工作日内提交。依据 D12", ["“20个工作日”在它引用的资料里找不到"])]

def run(path):
    """返回一串没过的测试。空的就是全过"""
    failed = []
    try:
        target = load(path)
    except Exception as error:
        return [f"文件根本跑不起来：{type(error).__name__}: {error}"]
    from cases import CASES
    for n, ((material, _, _), want) in enumerate(zip(CASES, OLD), 1):
        try:
            got = target.check_text(material)
        except Exception as error:
            got = f"报错 {type(error).__name__}"
        if got != want:
            failed.append(f"旧功能，第 {n} 份：该是 {want}，得到 {got}")
    for n, (material, want) in enumerate(EXTRA, 1):
        try:
            got = target.check_text(material)
        except Exception as error:
            got = f"报错 {type(error).__name__}"
        if got != want:
            failed.append(f"旧功能，补充第 {n} 条：该是 {want}，得到 {got}")
    out = "_export_test.csv"
    if os.path.exists(out):
        os.remove(out)
    done = subprocess.run([sys.executable, path, "--csv", out], capture_output=True, text=True, timeout=60)
    if not os.path.exists(out):
        failed.append("新功能：运行 --csv 以后没有生成文件" + (f"（{done.stderr.strip().splitlines()[-1][:60]}）" if done.stderr.strip() else ""))
    else:
        rows = list(csv.reader(open(out, encoding="utf-8-sig")))
        if rows[:1] != [["编号", "毛病数", "毛病"]]:
            failed.append(f"新功能：表头该是 编号,毛病数,毛病，得到 {rows[:1]}")
        if len(rows) != 10:
            failed.append(f"新功能：该有 1 行表头加 9 行数据，得到 {len(rows)} 行")
        elif rows[4][1:2] != ["1"] or "D02" not in "".join(rows[4]):
            failed.append(f"新功能：第 4 份那一行该是 1 处毛病、提到 D02，得到 {rows[4]}")
        os.remove(out)
    return failed

if __name__ == "__main__":
    failed = run(sys.argv[1])
    print(f"15 条测试，没过 {len(failed)} 条")
    for line in failed:
        print("  ", line)
```

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/EcBQbS8myo75DqxXMvXcjcGvnHg.png|给旧机器扎一圈篱笆，再让它伸手进去加零件。]]

这就是前面那个小 Agent 自己跑去读的 `tests.py`。回到聊天框的姿势，把验收条件和那句吩咐一起交给它：

````python
# change.py：给旧工具 accept.py 加一个“导出”功能。两种改法，各试三遍
import re, time
from llm import chat, SPENT
from tests import run

OLD = open("accept.py", encoding="utf-8").read()
ASK = "下面是一个正在用的小工具 accept.py。请给它加一个导出功能：运行 python3 accept.py --csv 文件名 的时候，把那九份东西的检查结果导出成一个 CSV 文件。\n请输出修改后的完整文件，放在一个 ```python 代码块里。\n\n"
SPEC = """验收条件：
1. 原有的 check_text、check_file 的行为一点都不许变。有一套测试守着它们。
2. CSV 的表头正好是：编号,毛病数,毛病。下面九行，每份东西一行；“毛病”一栏里多条毛病用中文分号连起来。
3. 导出时资料库的版本，沿用运行时的环境变量，不要自己改。
4. 不带 --csv 运行时，和原来一模一样。
"""

def code(reply):
    found = re.findall(r"```python\n(.*?)```", reply, re.S)
    return max(found, key=len) if found else reply

def just_ask(n):
    """直接说：一句话，拿回来就用"""
    path = f"accept_a{n}.py"
    open(path, "w", encoding="utf-8").write(code(chat(ASK + OLD)))
    return path, 1

def with_spec(n, rounds=3):
    """先给验收：把条件说清；跑测试；没过的原样退回去，最多改三回"""
    path = f"accept_b{n}.py"
    talk = [{"role": "user", "content": ASK + SPEC + "\n" + OLD}]
    for r in range(1, rounds + 1):
        reply = chat(talk)
        open(path, "w", encoding="utf-8").write(code(reply))
        failed = run(path)
        if not failed:
            break
        talk += [{"role": "assistant", "content": reply},
                 {"role": "user", "content": "测试没有全过：\n" + "\n".join(failed) + "\n请改好，再输出一次完整文件。"}]
    return path, r

if __name__ == "__main__":
    for label, way in (("直接说", just_ask), ("先给验收", with_spec)):
        for n in (1, 2, 3):
            before, start = SPENT["tokens"], time.time()
            path, rounds = way(n)
            failed = run(path)
            old = sum(f.startswith("旧功能") or f.startswith("文件") for f in failed)
            new = sum(f.startswith("新功能") for f in failed)
            print(f"{label} 第 {n} 遍：改了 {rounds} 回，{time.time() - start:.0f} 秒，{SPENT['tokens'] - before} 个 token。"
                  f"旧功能坏了 {old} 条，新功能没过 {new} 条")
            for line in failed[:3]:
                print("     " + line[:100])
        print()
````

```
先给验收 第 1 遍：改了 1 回，8 秒，2147 个 token。旧功能坏了 0 条，新功能没过 0 条
先给验收 第 2 遍：改了 1 回，8 秒，2147 个 token。旧功能坏了 0 条，新功能没过 0 条
先给验收 第 3 遍：改了 1 回，8 秒，2141 个 token。旧功能坏了 0 条，新功能没过 0 条
```

三遍都是一回就过。两千个 token，是小 Agent 的八分之一。

这两个实验说的是同一件事的两面。要让它做出你要的那一个，那份“要什么”总得在某个地方。你可以把它写在吩咐里递过去。你也可以把它写成测试放在仓库里，再给它一副会自己去读、自己去跑的 harness。六站走下来，变的是它自己能走多远。那份“要什么”得由你写出来，这一条从第一站到第六站没有变过。

还有一个小尾巴。把它交回来的文件和原来的逐行比一比，会发现第一行那句注释不见了。它顺手删了。十五条测试没有一条管注释，所以没有一条亮红灯。

篱笆圈住的地方，它没碰。篱笆没圈到的地方，它动了。规格也是人写的，也会漏。

## 写得快的那一段

回到题目。六站走下来，写代码这件事快了不知多少倍。项目呢？

那套测试，六十二行，是新功能的三倍长。里面每一条“该查出什么”，都得有人先想清楚。它交回来的文件，每一遍都得有人逐行看过。注释被删掉那件事，就是这么看出来的。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/X2QTbuMz4oax6QxjFRvck9dYn8g.png|它写完了。你才刚开始读。]]

2025 年 7 月，研究机构 METR 发表了一个对照实验。他们请了 16 位有经验的开源开发者，在这些人自己维护了多年的大型项目里，挑出 246 个真实的任务。每个任务抛硬币决定：这一个可以用 AI 工具，那一个不许用。然后计时。

动手之前，开发者们估计：用 AI，能快 24%。

实际量出来：用了 AI 的任务，花的时间多了 19%。

实验做完，再问这些开发者感觉如何。他们仍然觉得自己快了 20%。

![[零基础学AI/attachments/探索拓展 A｜AI 开发方式：代码写得更快，项目就会更快吗？/WhGfbLLurocEpMxgaSFc2xIhn3V.png|时间花在了哪儿。]]

这个实验的分量要说准。研究者自己写得很清楚：这是 2025 年初的工具，是很熟悉自己项目的老手，是很大、很成熟的代码库。按这一篇的站名，那是第三站到第五站之间。这篇报告后来被他们自己标注为“已过时”，并给出了一份 2026 年初的更新，那份更新我没有读到。

所以请不要记那个 19%。请记住那个差距：量出来是慢了，人却觉得快了。

写的那一段确实快了，快得看得见。读、验、返工的时间是散的，摊在后面，没有人给它计时。

**交付一个改动要花的时间，是写、读、验、返工、往后维护加在一起。六站走下来，第一项短得快没了。** 剩下的几项，有的没变，有的还变长了：它写得越多，你要读的越多。

## 接回验收卡

这条支线上的每一站，办法都不是新的。

灰字是第 04 章的接下一句。搬进编辑器，是让它自己去翻资料，第 07 章。终端里的那个圈是第 09 章。派出去是第 12 章和第 13 章。扎篱笆是第 14 章的“给尺子出考卷”。

所以代码这一行的验收卡，和资料助手的那一张长得差不多。“量过什么”那一节，多问四句：

这次改动之前，旧功能的基线记下来了吗？

验收条件是在它动手之前写的，还是看了它的结果以后补的？

它交回来的东西，有人逐行读过吗？读的时间算进去了吗？

用的是哪一副 harness？它能碰什么，不能碰什么，尺子归不归它管？

四句都答得上来，省下的那九秒钟才算数。

## 合上之前，想一想

1. 六站里，你现在主要用的是哪一站的姿势？有没有哪件事，你其实该退回前一站去做？
2. 第一站的灰字、第二站的聊天框、第五站没有“跑测试”的小 Agent，三回都自己定了表头，定得还都不一样。请想一想：这是模型的毛病，还是那句吩咐的毛病？
3. 有了“跑测试”这样工具，它先去读了测试。请你改一改 `mini.py`：不给它“跑测试”，只在吩咐里加一句“文件夹里有一套测试”。你估计它会去读吗？试一试。
4. `mini.py` 不许它改 `tests.py`。请再想出两样你不愿意让它碰的东西，说说如果是你来写这副 harness，你打算怎么拦。
5. 第六站里，你一次派出去五件事。请估一估：五件事都回来以后，你要花多久才敢把它们合进主线？这个时间和它们干活的时间比，哪个长？
6. METR 实验里的开发者做完以后仍然觉得自己快了。你上一次用 AI 写代码，觉得省了多少时间？这个数你量过吗？

## 来源

1. Copilot 的技术预览（2021 年 6 月 29 日，VS Code）、正式发布（2022 年 6 月 21 日）、最初由 OpenAI Codex 驱动（“GPT-3 的一个改造过的生产版本”）、2025 年 2 月的 agent mode 与 5 月的 coding agent，均据英文维基百科“GitHub Copilot”条目。“AI 结对程序员”出自 N. Friedman, Introducing GitHub Copilot: your AI pair programmer, GitHub，2021 年 6 月 29 日。Copilot 对话功能最初上线的日期没有核对到，条目只写到 2023 年 11 月它改用 GPT-4；正文写的是“到 2023 年”。
2. Cursor（Anysphere 公司，2022 年由四名麻省理工学生创办；2025 年 10 月的 2.0 版支持多个 Agent 借助 git worktree 并行）据英文维基百科“Cursor (company)”条目。编辑器首次发布的年份、“红的是删，绿的是添”这类界面细节，条目里没有，是概括说法。
3. C. Jimenez 等, SWE-bench: Can Language Models Resolve Real-World GitHub Issues?, arXiv:2310.06770，2023 年 10 月。数字出自摘要。
4. Devin（Cognition，十人团队；发布于 2024 年 3 月；有视频博主指其未完成演示中的任务）据英文维基百科“Devin AI”条目及其所引报道的标题。“第一个 AI 软件工程师”是当时报道的说法。
5. Claude Code（2025 年 2 月发布，“从终端用自然语言派活的命令行工具”，5 月正式可用）与 Cowork（2026 年 1 月研究预览；9 月其独立入口并入普通对话）据英文维基百科“Claude (AI)”条目。Codex CLI（2025 年 4 月 16 日开源）、Codex Cloud（5 月 16 日，每个任务单独的云端环境，多数 1 到 30 分钟）、桌面应用（2026 年 2 月发布，7 月并入 ChatGPT 桌面应用）据英文维基百科“OpenAI Codex”条目。这些条目记的是很近的事，可能还会改。
6. AGENTS.md 的说法与“六万多个开源项目”据其主页 agents.md。“harness”一词的用法可参见 J. Young, Effective harnesses for long-running agents, Anthropic，2025 年 11 月 26 日；“挽具”的比方是本书的。计划模式、钩子、compaction、上下文工程这几个名字，是按作者自己所用工具里的叫法概括的，各家工具的做法和叫法不完全一样。
7. A. Karpathy 关于 vibe coding 的帖子，2025 年 2 月 2 日。原帖页面未能读取，日期和引语据英文维基百科“Vibe coding”条目所录的原文。D. Delimarsky, Spec-driven development with AI: Get started with a new open source toolkit, GitHub，2025 年 9 月 2 日。
8. J. Becker, N. Rush, B. Barnes, D. Rein, Measuring the Impact of Early-2025 AI on Experienced Open-Source Developer Productivity, METR，2025 年 7 月 10 日。该页面已被作者标注为“结果已过时”，并指向 2026 年 2 月的更新；更新的内容本篇没有读到。“那是第三站到第五站之间”是本书按年份的归类，不是研究者的说法。
9. 本篇的代码与运行输出均为实际运行结果，取自 2026 年 11 月对商汤 Token Plan 兼容接口（senseaudio-s2-flash，接口规范与《上册》《下册》通用）的实测。第一站的“灰字”是用今天的对话模型模仿出来的，不是 2021 年的 Codex。第三、四、六站没有做实验。每种做法只试了三遍，被改的工具只有五十几行；“有了跑测试它就先去读测试”只在这三遍里成立。写测试和读代码所花的时间没有计时，图里那两条的长短只是示意。

> **延伸阅读**：[[附录｜探索拓展：AI 在各行各业|返回探索拓展总览]] · [[第 14 章｜把“做出来”变成“交得出去”|回到《上册》第 14 章验收]] · [[下册第 01 章｜和模型说上话：Token Plan、流式输出、缓存与账本|前往《下册》动手实践]]
