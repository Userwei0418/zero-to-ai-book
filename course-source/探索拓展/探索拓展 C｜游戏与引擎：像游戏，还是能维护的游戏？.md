---
source: https://sensetime.feishu.cn/wiki/UbxCwCDTritCXXk4ryxcFBTAnkh
fetched: 2026-11-16 15:14:56 (Asia/Shanghai)
revision: 7
---

# 探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？

*附录｜探索拓展。这一条支线讲的是“让机器替你造游戏”。它比这本书里别的支线都老，头一站在 1980 年。这一篇可以单独读，结尾接回第 14 章的验收。*

## 一间房，一把钥匙，一扇门

做一个世界上最小的游戏。

一间 7 列 5 行的房间，四周是墙。你站在左下角。地上有一把钥匙，右边的墙上有一扇门。走到钥匙上就捡起来，带着钥匙才进得了门，进了门就赢。还要能存档。

```
#######
#.....#
#..k..D
#@....#
#######
```

`@` 是你，`k` 是钥匙，`D` 是门。

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/HYQXbiotjosNG8x3CkJckTSTnDd.png|一间小房间，一把钥匙，一扇门。]]

这一篇就拿这间房当尺子。“让机器替你造游戏”这件事，四十多年里换过五种做法。每一种，交到你手上的东西都不一样。

## 第一站：写规则，让它生成

1980 年有一个叫 Rogue 的游戏。你每开一局，地牢的房间和走廊都是新的，没有两局一样。

没有人画了一万张地图。作者写的是一套规则：房间多大，怎么连，怪物怎么撒。每开一局，程序照着规则现造一座。这个做法叫**程序化生成**。几十年后有一个太空游戏用同样的路子，号称造出了一千八百亿亿颗各不相同的行星。

请留意这是哪一种“生成”。这是第 01 章：人把规则写下来，机器照办。规则写得出的，它能造出无穷多；规则里没有的，一样也造不出来。

你那间房，在这一站得自己写。写完以后，你可以让钥匙每局换个地方。

## 第二站：往游戏里添东西

语言模型出来以后，头一个念头不是让它造游戏，是让它往游戏里添东西。

2019 年有一个文字冒险游戏 AI Dungeon 2，你打什么字，故事就往哪儿编，没有预先写好的剧本。2023 年 3 月，大厂育碧公布了一个内部工具，让模型替编剧起草路人角色的那些零碎台词，编剧再挑、再改。

贴图，配音，台词，任务描述。这一站里，模型产出的是**素材**。素材被人挑过，放进一个照旧由人搭起来的工程里。

这一站也最早闹出了纠纷。2024 年 7 月，美国的游戏配音演员开始罢工，一直罢到 2025 年 7 月。争的是一件事：用 AI 复制他们的声音和形象，要不要本人同意，要不要付钱。最后签下的协议，写进了同意和告知的要求。

## 第三站：干脆不要引擎

2024 年，有人把这件事整个倒了过来。

游戏引擎是做游戏用的那一整套软件：画画面，算碰撞，管存档。这一站的想法是：这些全都不要。让一个模型看着你按的键，一帧一帧把下一幅画面直接画出来。

8 月，谷歌的几位研究者发表了 GameNGen：一个神经网络，不靠任何游戏引擎，实时“演”出了 1993 年的老游戏《毁灭战士》，每秒 20 帧。请人来看短片段，他们分辨真游戏和模型演出来的画面，只比瞎猜好一点点。

10 月 31 日，有团队放出了一个可以公开试玩的 Oasis，画面像《我的世界》，同样没有一行游戏代码。玩过的人很快发现了它的怪处：场景和背包里的东西会说变就变。

谷歌 DeepMind 的 Genie 走得更远。2024 年 3 月的第一代只能生成二维的小世界，大约一秒一帧。12 月的第二代有了三维，一个世界能撑十到二十秒。2025 年 8 月的 Genie 3 能以 720p、每秒 24 帧实时生成一个你可以走进去的世界。2026 年 1 月 29 日，它向一部分付费用户开放了，每次探索上限 60 秒。开放的第二天，几家游戏公司的股价跌了。

官方写明了它的限度：画面的记忆最多回溯到一分钟以前。

一分钟。请把你那间房放进去想一想。你捡起钥匙，转身出去绕了一圈，两分钟以后回来。

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/JIkKbG84VoclOdxySihceMLunWf.png|你才出去两分钟。]]

门还在不在右边的墙上，没有人能担保。这一站交到你手上的，是一段可以操作的影像。它没有规则，没有状态，也就没有存档，没有“改一下守卫的速度”。

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/Hx6QbRR8soRib8xcGpxcyXJPnWb.png|“AI 做游戏”，其实是三条路。]]

## 第四站：一句话，出一个工程

2025 年 2 月，“跟着感觉写代码”有了名字，vibe coding。头一批拿它来试的东西里，游戏最多。道理不难想：游戏做坏了没人受伤，做成了立刻能玩。

这一站和上一站正相反。模型写出来的是游戏的**代码**。规则写在代码里，状态存在变量里。它可以存档，可以测试，可以接着往下改。

这一站我们真做。把开头那段话交给模型，请它写出来。写三遍。

````python
# make.py：请模型写一个最小的游戏。一间房，一把钥匙，一扇门。写三遍，存成 room1.py、room2.py、room3.py
import re
from llm import chat

ASK = """请用 Python 写一个最小的回合制小游戏，只用标准库，放在一个文件里。
玩法：一间 7 列 5 行的房间，四周是墙（#）。玩家（@）从左下角的空地出发。房间里有一把钥匙（k）。右边的墙上有一扇门（D）。
玩家每回合走一格（w 上、s 下、a 左、d 右）。走到钥匙上就把它捡起来。身上有钥匙才能走进门；走进门，游戏胜利。
请提供这五个函数，别的随你：
- new_game() 返回一局新游戏的状态（一个可以用 json 存起来的字典）
- step(state, key) 走一步，返回新的状态
- render(state) 返回一幅用字符画的房间（字符串）
- save(state) 返回一个字符串；load(text) 把它变回状态
- won(state) 返回这一局赢了没有
请把完整文件放在一个 ```python 代码块里。"""

if __name__ == "__main__":
    for n in (1, 2, 3):
        reply = chat(ASK)
        found = re.findall(r"```python\n(.*?)(?:```|$)", reply, re.S)        # 它有时候忘了写收尾的那一行
        open(f"room{n}.py", "w", encoding="utf-8").write(max(found, key=len) if found else reply)
        print(f"room{n}.py 写好了，{len(open(f'room{n}.py', encoding='utf-8').read().splitlines())} 行")
````

```
room1.py 写好了，144 行
room2.py 写好了，144 行
room3.py 写好了，147 行
```

三份都写出来了，各一百四十来行，都跑得起来。到这一步，三份看上去都是游戏。

请你先想一想：要知道它们是不是真的能玩，你打算怎么查？

第一把尺子最自然：玩一遍。照着最顺的路走，捡钥匙，走到门口，进门，看赢不赢。

第二把尺子是请一位裁判。它不走顺的路。它专门去钻边角：没拿钥匙去撞门；闭着眼乱走三百步；捡了钥匙以后存档、读档，看钥匙会不会又回到地上；赢了以后再按键；按一个不认识的键。一共七项。这位裁判看不到游戏里面的变量。它和玩家一样，只看画出来的那幅字符画。

```python
# play.py：两把尺子。试玩：照着最顺的路走一遍，看赢不赢得了。裁判：专门去钻边角
# 用法：python3 play.py room1.py room2.py room3.py
import copy, importlib.util, json, random, sys

def load_game(path):
    spec = importlib.util.spec_from_file_location("game", path)
    game = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(game)
    return game

def find(game, state, mark):
    """在画出来的房间里找一个记号的位置（行，列）。找不到返回 None"""
    lines = game.render(state).split("\n")
    for r, line in enumerate(lines):
        if len(line) == len(lines[0]) and mark in line:        # 只在房间那几行里找，底下的提示文字不算
            return r, line.index(mark)
    return None

def walk(game, state, target, limit=40):
    """朝一个位置走过去：先横着走，再竖着走。返回走完以后的状态"""
    for _ in range(limit):
        me = find(game, state, "@")
        if me is None or me == target:
            break
        key = ("d" if target[1] > me[1] else "a") if me[1] != target[1] else ("s" if target[0] > me[0] else "w")
        state = game.step(state, key)
    return state

def smoke(game):
    """试玩：捡钥匙，走到门口，进门"""
    state = game.new_game()
    key, door = find(game, state, "k"), find(game, state, "D")
    if key is None or door is None:
        return None                                            # 画面上找不到钥匙或者门，没法玩
    state = walk(game, state, key)
    state = walk(game, state, (door[0], door[1] - 1))
    state = game.step(state, "d")
    return game.won(state)

def referee(game):
    """裁判。返回查出来的毛病"""
    bad = []
    fresh = game.new_game()
    key, door = find(game, fresh, "k"), find(game, fresh, "D")
    if key is None or door is None:
        return ["新开一局，画面上找不到" + ("钥匙" if key is None else "门") + "。后面几项没法查"]
    # 1 没钥匙，进不了门
    s = walk(game, game.new_game(), (door[0], door[1] - 1))
    if find(game, s, "@") == (door[0], door[1] - 1):          # 只有确实走到了门口，才试这一条
        s = game.step(s, "d")
        if game.won(s):
            bad.append("没拿钥匙就进了门")
    else:
        bad.append("绕开钥匙走不到门口（没法试“没钥匙进不了门”）")
    # 2 撞墙走不出去：乱走 300 步，人一直在墙里面
    rng, s = random.Random(7), game.new_game()
    rows = game.render(s).split("\n")
    for _ in range(300):
        s = game.step(s, rng.choice("wasd"))
        if game.won(s):
            s = game.new_game()
        me = find(game, s, "@")
        if me is None or not (0 < me[0] < len(rows) - 1 and 0 < me[1] < len(rows[0]) - 1):
            bad.append("乱走的时候，人走到了墙上或者不见了")
            break
    # 3 钥匙捡起来以后，地上不该还有
    s = walk(game, game.new_game(), key)
    if find(game, s, "k"):
        bad.append("钥匙捡了，地上还画着一把")
    # 4 存档：捡了钥匙以后存档、读档，钥匙不该回到地上，身上的也不该丢
    text = game.save(s)
    back = game.load(text)
    if find(game, back, "k"):
        bad.append("读档以后，钥匙又回到了地上")
    back = walk(game, back, (door[0], door[1] - 1))
    back = game.step(back, "d")
    if not game.won(back):
        bad.append("读档以后，带着钥匙进不了门")
    # 5 step 不该偷偷改掉传进去的旧状态（不然“悔一步”就做不了）
    s0 = game.new_game()
    before = json.dumps(s0, sort_keys=True, ensure_ascii=False)
    game.step(s0, "d"); game.step(s0, "w")
    if json.dumps(s0, sort_keys=True, ensure_ascii=False) != before:
        bad.append("step 改掉了传进去的旧状态")
    # 6 赢了以后再按键，不该出事
    try:
        again = game.step(back, "a")
        if not game.won(again):
            bad.append("赢了以后再走一步，又变回了没赢")
    except Exception as error:
        bad.append(f"赢了以后再按键，程序报错：{type(error).__name__}")
    # 7 按了别的键，不该出事
    try:
        game.step(game.new_game(), "x")
    except Exception as error:
        bad.append(f"按了一个不认识的键，程序报错：{type(error).__name__}")
    return bad

if __name__ == "__main__":
    for path in sys.argv[1:]:
        try:
            game = load_game(path)
            result = smoke(game)
            print(f"{path}　试玩：{'赢了' if result else '没赢' if result is False else '玩不下去'}")
            bad = referee(game)
            print(f"{'':<10}裁判：查了 7 项，{len(bad)} 项有毛病" + "".join("\n" + " " * 14 + b for b in bad))
        except Exception as error:
            print(f"{path}　跑不起来：{type(error).__name__}: {error}")
```

```
room1.py　试玩：玩不下去
          裁判：查了 7 项，1 项有毛病
              新开一局，画面上找不到钥匙。后面几项没法查
room2.py　试玩：玩不下去
          裁判：查了 7 项，1 项有毛病
              新开一局，画面上找不到钥匙。后面几项没法查
room3.py　试玩：赢了
          裁判：查了 7 项，0 项有毛病
```

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/THZPboq00owxPTxFyzCcC7VAnHc.png|他趴在地上找钥匙。钥匙在它手里，没摆出来。]]

三份里，有两份玩不下去。

原因一样，而且有点好笑：画面上没有钥匙。

```
#######
#     #
#     D
#@    #
#######
```

钥匙其实是有的。翻它的状态，里面清清楚楚记着钥匙在第 2 行第 3 列。你走过去，也真的捡得起来。它只是忘了画。

同一句话，同一个模型，写三遍。两份有同一个毛病，一份没有。你要是只生成了一遍，拿到哪一份，看运气。

这一站后来走得很远。2026 年 6 月，一个新模型发布的时候，最出圈的演示就是“一句话生成一个能玩的游戏”。11 月，那家公司的一位员工晒出了一个在浏览器里跑的三维射击游戏，说是一句话的要求做出来的。据报道，那一句话后面，模型自己干了八个小时，花了五百多美元。

请留意那八个小时。“一句话”说的是你这一头。它那一头，是附录 A 第五站、第六站的那一套：一个圈，一副 harness，转了八个小时。我没有玩到那个游戏。它过没过得了下面这一节的检查，报道里没有说。

## 再加一条规则

“能维护”说的是另一件事：它今天能跑，明天你要加东西的时候，它会不会散。

拿那份没毛病的第三份，加一条新规则：房间最上面一行有一个守卫，来回巡逻，你和它站到同一格就输。让模型改三遍。每一遍改完，裁判把旧的七项重查一遍，再加查一项新的：守卫走到一半的时候存档、读档，接下来它该往哪边走，不能变。

这一项是有来历的。存档只存了守卫站在哪儿、没存它正朝哪边走，是这类小游戏里最常见的毛病之一。读档以后，守卫会掉头。

````python
# grow.py：在那份没毛病的 room3.py 上加一条新规则：一个来回巡逻的守卫。改三遍，每遍都让裁判把旧的七项重查，再加查一项新的
import os, re
from llm import chat
from play import load_game, referee, find

ASK = """下面是一个正在用的小游戏 room3.py。请加一条新规则，别的都不要变：
房间最上面那一行空地里有一个守卫（G），从最左边的空地出发，每回合（玩家每走一步之后）横着走一格，走到头就掉头。
玩家和守卫站到同一格，游戏失败。请增加一个函数 lost(state) 返回输了没有；输了以后再按键，状态不再变化。
请把完整文件放在一个 ```python 代码块里。

"""

def guard_after(game, state, keys):
    """玩家在最下面一行来回走，守卫在最上面一行巡逻，两不相碰。返回守卫每一步站在哪一列"""
    seen = []
    for key in keys:
        state = game.step(state, key)
        seen.append((find(game, state, "G") or (None, None))[1])
    return seen

def new_check(game):
    """新加的一项：守卫走到一半存档、读档，接下来它该走的路不能变"""
    s = game.new_game()
    if find(game, s, "G") is None:
        return ["画面上找不到守卫"]
    for key in "dadada":                                      # 先走六步，守卫这时候已经掉过头了
        s = game.step(s, key)
    straight = guard_after(game, s, "dada")
    resumed = guard_after(game, game.load(game.save(s)), "dada")
    if len(set(straight)) < 2:
        return [f"守卫没有在走：{straight}"]
    return [] if straight == resumed else [f"读档以后守卫走岔了：不读档是 {straight}，读档以后是 {resumed}"]

if __name__ == "__main__":
    old = open("room3.py", encoding="utf-8").read()
    for n in (1, 2, 3):
        path = f"room3_guard{n}.py"
        if not os.path.exists(path):                          # 已经改好的不重改，只重查
            reply = chat(ASK + old)
            found = re.findall(r"```python\n(.*?)(?:```|$)", reply, re.S)
            open(path, "w", encoding="utf-8").write(max(found, key=len) if found else reply)
        try:
            game = load_game(path)
            bad_old, bad_new = referee(game), new_check(game)
            print(f"{path}　旧的七项：{len(bad_old)} 项有毛病；新的一项：{'有毛病' if bad_new else '没毛病'}"
                  + "".join("\n" + " " * 8 + b for b in bad_old + bad_new))
        except Exception as error:
            print(f"{path}　跑不起来：{type(error).__name__}: {error}")
````

```
room3_guard1.py　旧的七项：0 项有毛病；新的一项：没毛病
room3_guard2.py　旧的七项：0 项有毛病；新的一项：没毛病
room3_guard3.py　旧的七项：0 项有毛病；新的一项：没毛病
```

三遍，旧的七项全过，新的一项也过。

我本来以为加规则这一步会出事。它没有。三遍改出来的东西，都把守卫朝哪边走也存进了状态里。

## 裁判也错了两回

这一节得单独写出来，因为它比上面的结果更要紧。

上面那两段输出，都不是我第一次跑出来的样子。

第一回，裁判对第三份报了两条毛病：“钥匙捡了，地上还画着一把”“读档以后，钥匙又回到了地上”。我差一点就把这两条写进正文了。回头去看第三份画出来的画面，才发现它捡到钥匙以后，会在房间底下加一行英文提示，大意是“你拿到钥匙了”。那句话里有 key 这个词。我的裁判在画面里找字母 k，找到了那个 key 里的 k。

钥匙没有回到地上。是裁判认错了字。

第二回，是加守卫以后的那一项新检查。头一版里，我让玩家按一个不认识的键，心想这样玩家不动、守卫照走。三遍全过。我又去看了一眼守卫到底走了没有。它没走。在这三份改出来的游戏里，按一个不认识的键不算一回合，守卫一步都不动。存不存档，它都站在原地，当然“走的路没变”。

那一项检查什么都没查，却给了三个“通过”。

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/LEgRbimoCoe8QcxsTQacDLNBnIf.png|让一只发条老鼠先去房间里乱撞。]]

两回错的方向正好相反。头一回，裁判把对的判成了错的。第二回，它对着一件根本没查的事说了“没问题”。后一种更危险，因为没有任何东西会提醒你。

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/SbFJb3701o4amqxxkYbcI04inxh.png|三份小游戏，两把尺子。]]

## 第五站：Agent 进了引擎

一间房的游戏，一个文件就写完了。真的游戏不是这样。

一个像样的游戏工程里，代码只是一小部分。更多的是场景、模型、动画、材质、音效，和把它们连在一起的成千上万个设置。这些东西住在引擎的编辑器里，靠人拿鼠标一样一样摆。模型会写代码，可它够不着编辑器。

这两年引擎做的事，就是把编辑器的门打开。

2024 年 10 月发布的 Unity 6，带上了自家的生成式 AI 工具。虚幻引擎这边走得更明白，下面这几步据游戏媒体的报道：2025 年 11 月的 5.7 版，编辑器里有了 AI 助手。2026 年 6 月的 5.8 版带了一个实验性的插件，让外面的模型通过 MCP 直接操作编辑器里的工程。这就是第 10 章的那个接口，接到了引擎上。同一年，Epic 公布了下一代的虚幻引擎 6，说要把 Claude、Gemini 这样的模型接进引擎。

2026 年 11 月 9 日，Epic 放出了 5.9 的一个预览版。编辑器里多了一块面板，可以直接接上附录 A 第五站的那几样终端工具。Epic 自己的说法是，这个预览版本身，主要就是靠 Agent 的工作流做出来的。报道说，开发者们对这一版的看法分成了两边。

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/JJnublLAVoaiy4xB2fTcFQBlnNg.png|它坐到了那张全是拉杆的台子前面。]]

这一站交到你手上的，是引擎里的一串改动。它留在工程里，你打得开，看得见，改得了。

也请把上一节的教训带过来。一间房的游戏，裁判七项就查得差不多了。一个引擎工程里，Agent 一口气动了两百处设置，谁来当那位裁判？

![[零基础学AI/attachments/探索拓展 C｜游戏与引擎：像游戏，还是能维护的游戏？/Z4PWbuyvpoFvbSxxLOgcAH8wngd.png|让机器替你造游戏，这几十年走了五站。]]

## 像游戏，和能玩的游戏

所以这一篇的题目，可以答成四层。

**像游戏。** 有画面，按键有反应。我们的三份都过了这一层。第三站那些生成出来的世界，也在这一层上做到了惊人的地步。

**能玩。** 规则对，边角不出事，存了档能读回来。这一层要让测试去玩。三份里过了一份。

**能维护。** 加一条规则，旧的不坏，新的站得住。这一层要靠那七项检查一直守着，每改一次重查一次。这一回它过了。只有第一、二、四、五站交出来的东西，才谈得上这一层。

**好玩。** 这间房间有没有意思，守卫该走多快，钥匙放在哪儿才让人想玩第二遍。这一层只能让人去玩，而且得是很多人。测试能告诉你游戏没坏，告诉不了你它值不值得玩。五站走下来，这一层没有哪一站替你做了。

## 接回验收卡

这一行的验收卡上，“量过什么”那一节可以照着这四层来填。

画面看过了吗？谁看的？

规则是谁玩的？人玩了一遍顺路，还是测试钻了边角？钻了几项，哪几项？

改过以后，旧的检查重跑了吗？

有人真的玩过吗？玩了多久，愿不愿意再玩？

还要添一句这一篇用两个教训换来的话：**那几项检查本身，有没有人回头看过它到底查了什么。**

## 合上之前，想一想

1. 五站里，每一站交到你手上的东西都不一样。请为“我想做一个给朋友生日玩一次的小游戏”和“我想做一个要更新三年的游戏”各挑一站，说说为什么。
2. 两份游戏忘了画钥匙。裁判只看画面，所以发现了。如果裁判直接去读游戏的状态，它会发现吗？这两种查法，哪一种更接近玩家？
3. 我的裁判把 key 里的 k 当成了钥匙。请你改一改 `play.py`，让它不再犯这个错。再想一想：你改完以后，它还会在什么样的画面上认错？
4. 那一项“什么都没查”的检查给了三个通过。你怎样才能发现一项检查是空的？（提示：故意做一份有毛病的游戏，看它拦不拦得住。第 12 章和第 14 章都用过这个办法。）
5. Genie 3 的画面记忆大约一分钟。在这样一个世界里玩“一把钥匙一扇门”，你绕了两分钟回到门口，可能会发生什么？这算是毛病，还是这条路本来的样子？
6. “一句话生成一个射击游戏”，背后是八个小时。请列出你想问那位演示者的三个问题。

## 来源

1. 程序化生成与 Rogue（1980 年）、“一千八百亿亿颗行星”，据英文维基百科“Procedural generation”条目。AI Dungeon 2（2019 年）与育碧的 Ghostwriter（2023 年 3 月），据英文维基百科“Artificial intelligence in video games”条目；该条目带有“可能含模型生成文本”的提示，本篇只取了这两条。
2. 游戏配音演员罢工（2024 年 7 月 26 日至 2025 年 7 月 9 日；争议与结果）据英文维基百科“2024–2025 SAG-AFTRA video game strike”条目。
3. D. Valevski, Y. Leviathan, M. Arar, S. Fruchter, Diffusion Models Are Real-Time Game Engines（GameNGen）, arXiv:2408.14837，2024 年 8 月。Oasis 的发布日期与“场景和背包会变”的说法，据英文维基百科“Oasis (Minecraft clone)”条目。Genie 三代的时间与能力、2026 年 1 月 29 日向订阅用户开放（上限 60 秒）、此后几家游戏公司股价下跌，据英文维基百科“Genie (world model)”条目；Genie 3 的限度另据 Google DeepMind, Genie 3: A new frontier for world models，2025 年 8 月 5 日。
4. Unity 6（2024 年 10 月 17 日发布，带生成式 AI 工具）据英文维基百科“Unity (game engine)”条目。虚幻引擎 5.7、5.8、5.9 预览版与虚幻引擎 6 的 AI 功能，维基百科条目没有记载，这几句据 2025 年 11 月至 2026 年 11 月的游戏媒体报道（Digital Production、Engadget、Wccftech、Inven Global、Creative Bloq 等），是检索结果的二手转述，没有读到 Epic 的原始公告。“主要靠 Agent 的工作流做出来”是报道转述的 Epic 的说法。
5. “2026 年 6 月一个新模型发布时演示一句话生成游戏”“11 月一位员工晒出浏览器里的三维射击游戏，八小时、五百多美元”，据科技媒体的报道（The Shortcut、3DNews 等），没有独立核实，作者也没有玩到。vibe coding 一词的来历见附录 A。“头一批拿它来试的东西里游戏最多”是概括说法。
6. 本篇的代码与运行输出均为实际运行结果，取自 2026 年 11 月对商汤 Token Plan 兼容接口（senseaudio-s2-flash，接口规范与《上册》《下册》通用）的实测。游戏只写了三遍，新规则只改了三遍，样本很小。正文里的两段裁判输出，是修正了裁判自己的两处错误之后重跑的结果，经过写在“裁判也错了两回”一节。五站里只有第四站做了实验。

> **延伸阅读**：[[附录｜探索拓展：AI 在各行各业|返回探索拓展总览]] · [[第 14 章｜把“做出来”变成“交得出去”|回到《上册》第 14 章验收]] · [[下册第 01 章｜和模型说上话：Token Plan、流式输出、缓存与账本|前往《下册》动手实践]]
