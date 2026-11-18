---
source: https://sensetime.feishu.cn/wiki/OfJIw4OEGiZwMxkvxjAcxehinqh
fetched: 2026-11-16 15:14:57 (Asia/Shanghai)
revision: 8
---

# 探索拓展 D｜设计／画板：像成品，还要能继续编辑

*附录｜探索拓展。这一条支线讲的是“让机器替你出图”。它有一段别的支线没有的弯路：三十年攒下的一样本事，被一步丢掉，又一点一点捡了回来。这一篇可以单独读，结尾接回第 14 章的验收。*

## 一张海报

测试组要办一场新人欢迎会。组长让你出一张海报：活动名，组名，日期，时间，地点，左上角放个组徽。

海报出完，组长多半还有两句话等着你。一句是“时间改到 15:00”。另一句是“公司的品牌色定了，换成那个”。

这一篇就拿这张海报和这两句话当尺子。同一件事，放到六个年份里各做一遍。

## 第一站：图层

设计这一行，三十年前就为“改”这件事吵过一次。

早期的修图软件里，一张图就是一整块像素。你把字打上去，字就和背景长在了一起。想挪一下，只能把那一块挖掉重来。

1994 年，Photoshop 3.0 带来了**图层**，这个做法从此铺开。字在一层，背景在一层，各改各的。再后来，矢量格式让“一个圆”一直是一个圆，不会变成一堆像素。2001 年成为网络标准的 SVG 就是其中一种：它是一份文本，里面的字就是字，搜得到。再往后，设计工具里有了**组件**和**变量**。一个按钮画一次，用一百处；主色定一个名字，改一处，一百处一起变。

这条路上的每一步，买的都是同一样东西：**改的时候，只动你想动的那一处。**

在这一站，海报得你自己画。画完以后，改时间是双击那一行字，换颜色是改一个变量。两句话，两秒钟。

## 第二站：一句话，一张图

2022 年，三样东西在半年里接连出现。

4 月，OpenAI 公布了 DALL·E 2。7 月 12 日，Midjourney 开始公测，用法很怪：你得进一个聊天群，在里面敲一行命令，它回你四张图。8 月 22 日，Stable Diffusion 发布，代码和模型都是公开的，一块家用的显卡就跑得动。

一句话，出一张像模像样的画。那个夏天，很多人第一次觉得“画画”这件事要变了。

8 月 29 日，美国科罗拉多州的博览会上，一幅叫《太空歌剧院》的画拿了新人组的头奖。作者后来说明，它是用 Midjourney 做的，前后试了至少六百多次。评委说，事先不知道，可知道了也会给。一年以后，美国版权局的复审委员会认定这幅画不能登记版权，理由是其中人的投入太少。

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/YVVfbkbqtoOq1hxD9GFcy38Onag.png|一句话，四张图。标题那一块是一团鬼画符。]]

请把你的海报放进这一站。

画面会很漂亮。然后你去找“新人欢迎会”那几个字。那一年的图像模型不会写字。DALL·E 2 写出来的字，有人形容像梦话。至于“时间改到 15:00”，没有“时间那一行”这个东西。一张图是一整块像素。再说一遍那句话，出来的是另一张完全不同的画。

图层那一站攒下的本事，这一站一步就丢了。

## 第三站：搬进修图软件

丢了的东西，头一个想着去捡的，是做修图软件的那家。

2023 年 3 月，Adobe 的 Firefly 开放公测。两个月后，它被接进了 Photoshop：你在原图上圈出一块，说一句“这儿加一只猫”，它只重画圈住的那一块。

这是一个朴素的折中。模型还是只会吐像素，可它吐的那一块，落在你选的图层上，落在你圈的范围里。别的地方一个像素都不动。

Adobe 还打了一张别家没法打的牌：它说自己的模型是用自家图库和公有领域的图训练的，生成的东西可以放心商用。一年以后有报道说，训练用的图里也混着别家模型生成的图，这一点它没有讲清楚。

同一年，字也慢慢写得出来了。10 月进到 ChatGPT 里的 DALL·E 3，12 月的 Midjourney 第六版，都把“字写得更对”列成了卖点。

## 第四站：会写字，也会照着改

2025 年 3 月 25 日，OpenAI 把一种新的图像生成直接放进了 ChatGPT。它不再是从一团噪点里“显影”出一张图，而是像写字一样一小块一小块往下画。你可以贴一张图进去，说“把这儿改掉”。字写得对了。第一个星期，一亿三千万人用它画了七亿多张图，满网都是把自家照片变成动画片的。

8 月，谷歌的一个模型以“Nano Banana”这个绰号走红。它的本事正是“改”：同一个人、同一样东西，改上好几轮，还认得出是原来那个。

到这一站，我们可以真做了。把开头那段话直接交给图像模型。

```bash
# flat.sh：请图像模型直接画一张海报，再请它只改一处。用法：bash flat.sh 出图脚本所在的文件夹 图片要放的文件夹
S="$1"; F="$2"
POSTER="A clean event poster, portrait-like composition inside a wide 3:2 frame, cream background, navy and teal and mustard palette, simple leaf decorations. Large Chinese headline text: 新人欢迎会. Smaller lines of Chinese text below, exactly: 测试组 ｜ 11月20日 14:00 ｜ 三楼会议室. A small round logo with the two Chinese characters 测试 in the top left corner."
python3 -I "$S/oai_img.py" "$F/d_flat_1.png" "$POSTER"
python3 -I "$S/oai_img.py" "$F/d_flat_2.png" "Change only the time on this poster from 14:00 to 15:00. Keep everything else exactly the same: same layout, same text, same decorations, same colours." "$F/d_flat_1.png"
```

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/GcnTboRMQooclcxPjLYck1lJnZd.png|直接画出来的海报。]]

说实话，比我预想的好得多。配色稳，留白像样，每一个中文字都写对了。

然后是组长的第一句话：时间改到 15:00。

我以为会看到第二站的那种场面：重画出来的处处不同，叶子换了形状，字挪了位置。

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/V26PbwrTPofp8TxRt6ZcuJ25nSc.png|只改了时间。]]

并没有。肉眼看，除了 14 变成了 15，两张一模一样。我不放心，写了几行程序逐个像素去比：

```python
# pixels.py：两张图，有多少像素不一样。不用第三方库：先让系统自带的 sips 把图转成 BMP，再一个字节一个字节地比
import struct, subprocess, sys

def pixels(path):
    bmp = path + ".bmp"
    subprocess.run(["sips", "-s", "format", "bmp", path, "--out", bmp], capture_output=True, check=True)
    data = open(bmp, "rb").read()
    start, = struct.unpack_from("<I", data, 10)
    width, height = struct.unpack_from("<ii", data, 18)
    bits, = struct.unpack_from("<H", data, 28)
    return data[start:], width, abs(height), bits // 8

def changed(a, b, tolerance=24):
    """返回 (不一样的像素占几成, 这些像素落在画面上下左右的哪个范围里)"""
    pa, w, h, n = pixels(a)
    pb, w2, h2, _ = pixels(b)
    assert (w, h) == (w2, h2), "两张图大小不一样"
    row = (w * n + 3) // 4 * 4
    count, box = 0, [w, h, 0, 0]
    for y in range(h):
        base = y * row
        for x in range(w):
            i = base + x * n
            if max(abs(pa[i + k] - pb[i + k]) for k in range(3)) > tolerance:
                count += 1
                box = [min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y)]
    return count / (w * h), box, (w, h)

if __name__ == "__main__":
    share, box, size = changed(sys.argv[1], sys.argv[2])
    print(f"{size[0]}×{size[1]} 的图，有 {share:.1%} 的像素变了。变了的像素横向铺满 {(box[2] - box[0]) / size[0]:.0%}，纵向铺满 {(box[3] - box[1]) / size[1]:.0%}")

def ink(path, box=(0.15, 0.28, 0.90, 0.50)):
    """标题那一块里，最常见的深色是什么颜色。返回 #RRGGBB"""
    data, w, h, n = pixels(path)
    row, seen = (w * n + 3) // 4 * 4, {}
    for y in range(int(h * (1 - box[3])), int(h * (1 - box[1]))):          # BMP 是从最下面一行存起的
        for x in range(int(w * box[0]), int(w * box[2])):
            i = y * row + x * n
            b, g, r = data[i], data[i + 1], data[i + 2]
            if r + g + b < 330:                                             # 只数深色的
                key = (r, g, b)
                seen[key] = seen.get(key, 0) + 1
    r, g, b = max(seen, key=seen.get)
    return f"#{r:02X}{g:02X}{b:02X}"
```

```
1536×1024 的图，有 1.7% 的像素变了。变了的像素横向铺满 100%，纵向铺满 100%
```

全图只有 1.7% 的像素有变化。这些变了的像素散在整张图上，说明它确实整张重画过。可它重画得几乎分毫不差。

第二站丢掉的东西，这一站靠蛮力捡回来了一大半：它没有图层，它只是画得足够像。

再试组长的第二句话：品牌色是一种墨绿，色值 #2E6B4F。

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/LzPJb2uyhoXMkZxHfy8c1ston5b.png|换成了绿色。]]

换了，很好看。量一下标题的颜色：

```
直接画的那张，改色之前标题的颜色： #013058
要求改成 #2E6B4F。改完以后标题的颜色： #27704F
这一次有 14.7% 的像素变了
```

要的是 #2E6B4F，得到的是 #27704F。

两个绿色摆在一起，你多半分不出来。可品牌手册上写的是一个确切的值。印刷厂、网页、PPT 模板用的都是那个值。这张海报上的绿，和它们都差一点点。

模型画的是“一种墨绿”。它理解了你的意思，却没有一个地方可以存下 #2E6B4F 这六个字符。

还有两件事不用试也想得明白。欢迎会除了海报，还要胸牌和邀请卡，三样东西要用同一个组徽、同一种绿、同一行日期。明天时间又改了呢？三张图，各重画一遍，再各自比一遍。海报上那行“三楼会议室”，是画出来的笔画。你没法选中它，没法搜索它，读屏软件也读不出它。

## 第五站：接回图层

靠蛮力捡回来的，终究差那一点点。所以这一站干脆换了一个问法：别让它交一张图，让它交一份**分了层的稿子**。

2025 年 5 月，Figma 发布了 Figma Make，一句话生成能点、能跑的原型。10 月，Canva 推出了一个设计模型，生成的版面里每一层、每一个对象都能单独编辑。12 月有一篇论文干脆反过来做：给一张已经压平的图，把它拆回若干个带透明度的图层。

我们手边没有那些设计工具，可是有它们的道理。照着做一个最小的。

品牌只写在一个地方：主色，点缀色，底色，组名，活动名，日期，时间，地点。三张物料是三份模板，请模型来写。模板里不许出现任何一个写死的颜色，也不许出现任何一个写死的字。要用颜色的地方写 `{primary}`，要写时间的地方写 `{time}`。出图的时候，程序才把值填进去。

模型写完，先别急着看图。先查一件事：它有没有偷偷写死。

````python
# kit.py：换一种做法。品牌只写在一个地方；三张物料是三份模板，里面用占位符指着品牌；出图的时候才把值填进去
import json, re, subprocess, os
from llm import chat

BRAND = {"primary": "#26426B", "accent": "#D49A2F", "paper": "#F7F1E5", "team": "测试组",
         "event": "新人欢迎会", "date": "11月20日", "time": "14:00", "place": "三楼会议室"}

ASK = """请写一份 SVG 模板，画布 {w}×{h}，内容是：{what}
要求：
1. 颜色一律不许写死。主色写成 {{primary}}，点缀色写成 {{accent}}，底色写成 {{paper}}。
2. 文字内容一律不许写死。组名 {{team}}，活动名 {{event}}，日期 {{date}}，时间 {{time}}，地点 {{place}}。
3. 每个元素都起一个看得懂的 id。字体用 "Hiragino Sans GB"。
只输出 SVG 本身，放在一个 ```xml 代码块里。"""

PAGES = {"poster": (1200, 800, "一张横版活动海报：左上角一个圆形组徽（圆里写组名的前两个字用 {team} 即可），正中是很大的活动名，下面一行写 组名｜日期 时间｜地点，四角有简单的几何装饰。"),
         "badge": (600, 400, "一张胸牌：顶上一条主色的色带，色带里写活动名；中间留一块空白给人写名字，下面一行小字写组名和日期。"),
         "invite": (800, 500, "一张邀请卡：左边三分之一是主色的色块，里面竖排或横排写活动名；右边写“诚邀你参加”，以及日期、时间、地点三行。")}

def make():
    os.makedirs("templates", exist_ok=True)
    for name, (w, h, what) in PAGES.items():
        reply = chat(ASK.format(w=w, h=h, what=what))
        found = re.findall(r"```(?:xml|svg)?\n(.*?)(?:```|$)", reply, re.S)
        open(f"templates/{name}.svg", "w", encoding="utf-8").write(max(found, key=len) if found else reply)

def lint(name):
    """查绑定：模板里有没有写死的颜色，有没有写死的字"""
    text = open(f"templates/{name}.svg", encoding="utf-8").read()
    colours = sorted(set(re.findall(r"#[0-9A-Fa-f]{6}\b|#[0-9A-Fa-f]{3}\b", text)))
    words = sorted({w for w in BRAND.values() if not w.startswith("#") and w in text})
    return colours, words

def fill(name, brand, out):
    text = open(f"templates/{name}.svg", encoding="utf-8").read()
    for key, value in brand.items():
        text = text.replace("{" + key + "}", value)
    open(out, "w", encoding="utf-8").write(text)

if __name__ == "__main__":
    if not os.path.exists("templates/poster.svg"):
        make()
    for name in PAGES:
        colours, words = lint(name)
        print(f"{name}：写死的颜色 {colours or '没有'}；写死的字 {words or '没有'}")
````

```
poster：写死的颜色 没有；写死的字 没有
badge：写死的颜色 没有；写死的字 没有
invite：写死的颜色 没有；写死的字 没有
```

三份模板，一个写死的颜色都没有，一个写死的字也没有。

这一步设计工具里叫“绑定”。一个色块绑没绑在变量上，眼睛是看不出来的：绑了的和没绑的，画出来一模一样。差别要等到你改变量的那一天才露出来。所以它得由程序来查。

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/HV6Hb2cSLo8XktxWfdUcrZAhnQd.png|它只抽出中间那一张，别的没动。]]

现在改。时间改成 15:00，主色改成 #2E6B4F。两个值。

```python
# rebrand.py：同一个改动，在这一种做法里是什么样。改两个值：时间，主色。三张物料重新出一遍
# 用法：python3 rebrand.py 放图的文件夹 把SVG转成PNG的命令（本书用的是 resvg）
import subprocess, sys
from kit import BRAND, PAGES, fill
from pixels import ink

folder, to_png = sys.argv[1], sys.argv[2:]
NEW = dict(BRAND, time="15:00", primary="#2E6B4F")
for label, brand in (("a", BRAND), ("b", NEW)):
    for name in PAGES:
        svg = f"{folder}/d_kit_{name}_{label}.svg"
        fill(name, brand, svg)
        subprocess.run(to_png + [svg, svg.replace(".svg", ".png")], check=True)
print("改动的地方：", {k: (BRAND[k], NEW[k]) for k in BRAND if BRAND[k] != NEW[k]})
print("三张物料全部重出，没有再问模型，花了 0 个 token")
print("海报标题的颜色：改之前", ink(f"{folder}/d_kit_poster_a.png", (0.1, 0.3, 0.9, 0.6)), "，改之后",
      ink(f"{folder}/d_kit_poster_b.png", (0.1, 0.3, 0.9, 0.6)), "，要求的是 #2E6B4F")
```

```
改动的地方： {'primary': ('#26426B', '#2E6B4F'), 'time': ('14:00', '15:00')}
三张物料全部重出，没有再问模型，花了 0 个 token
海报标题的颜色：改之前 #26426B ，改之后 #2E6B4F ，要求的是 #2E6B4F
```

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/BiKgbAIE4oGppqxLJ9EcRytVngg.png|改之前的海报。]]

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/Ws0ebIxB6oMOKKx3gUdc4MhLnPg.png|改之后的海报。]]

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/DxZobtMjqogyGGxhINicixBMnoc.png|胸牌跟着变了。]]

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/UDEeb5sQIohdyPxDHgscV9pnnxb.png|邀请卡也跟着变了。]]

三张一起变了。标题的颜色是 #2E6B4F，一位不差。这一步没有再问模型，一个 token 没花。

## 可是你看那张邀请卡

到这里，这一站本来可以漂漂亮亮地收尾。

请你把上面那几张图再看一遍。

海报左上角的组徽，“测试组”三个字撑出了圆圈。

邀请卡右边，“日期：”“时间：”“地点：”后面是空的。三行字没画出来。

绑定检查全过。结构无可挑剔。画面是错的。

回头翻邀请卡的模板，那三个值其实都在，占位符也都写了。只是这三行字的颜色，它绑的是 `{paper}`，底色。米白的字，写在米白的底上。

查绑定的程序只认“有没有写死”。绑是绑了，绑得对不对，它不管；画出来是什么样，它也不看。

和第四站那张直接画的海报摆在一起，账是这样的：

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/Ed88b3ImIoJ1WmxJuNlcsinrnxd.png|同一张海报，两种做法。]]

直接画的那张，赢在第一行：它一眼看上去就是成品。后面四行，它都输。模板的这一套，后面四行全赢。第一行，它输了：偏素，还有两处明摆着的毛病。

谁也替不了谁。“像成品”是用眼睛验的。“能继续编辑”要动手改一次才验得出来。

## 第六站：Agent 进了画板

第五站让模型交出了分层的稿子。再往后的一步，你在附录 A 和附录 C 里已经见过两回：让 Agent 直接进到设计工具里去干活。

2026 年 2 月，Figma 宣布通过 MCP 接上了附录 A 第五站的那几样终端工具。写代码的 Agent 可以直接读到设计稿里的每一层、每一个变量，照着它写界面。4 月，Canva 放出了新一版 AI 的研究预览，里面有可以在后台自己干活的 Agent。

这一站还在路上，它带出来的事已经不只是技术上的。

2026 年 4 月，Anthropic 的一位高管辞去了 Figma 的董事。据报道，起因是 Anthropic 自己要出一样和 Figma 抢生意的设计工具。给你供模型的那家，转过身成了你的对手。

8 月，Canva 下调了全年的增长预期，说的原因是 AI 的算力开销。11 月，它裁了一千二百多人，占全公司的两成多。

第 14 章说过，一样东西值不值得用，要连账一起看。这一行的账，正在被重算。

![[零基础学AI/attachments/探索拓展 D｜设计／画板：像成品，还要能继续编辑/U6UEbUgY3oujnsxgWkBcexBfnUe.png|让机器替你出图，三十年走了六站。]]

## 接回验收卡

设计这一行的交付物，验收要过三层。

**看。** 画面对不对，好不好看，有没有溢出、漏字、对不齐。这一层，人眼最快。

**结构。** 字是不是字，层分没分开，颜色和文字绑没绑在变量上。这一层眼睛看不出来，要程序去查。

**改一次。** 真的改一个公共的值，看该变的是不是都变了，不该变的有没有跟着动。这一层只有动手才知道。

第四站的那张过了第一层。第五站的那一套过了后两层。一份真正交得出去的设计文件，三层都得过。

验收卡上还要添两行别的行当没有的。

**这份东西，下一个人打开以后，能不能接着改。** 设计稿很少有改完的一天。

**这张图，你有没有权用。** 第二站那幅得奖的画，第三站那句“可以放心商用”，争的都是这一行。

## 合上之前，想一想

1. 第二站一步丢掉了图层。后面四站，各用了什么办法把“只动一处”捡回来？哪一种是真的捡回来了，哪一种只是看着像？
2. 改时间那一步，图像模型几乎分毫不差地重画了一遍。既然这样，“图是一整块像素”还算不算一个毛病？请举一个它今天仍然做不到、而图层做得到的修改。
3. 要的是 #2E6B4F，得到的是 #27704F。你觉得这点差别要紧吗？对一张只在群里发一次的海报呢？对一套要用三年的品牌物料呢？
4. 邀请卡漏了三行字，绑定检查没查出来。请你给 `kit.py` 添一项检查，能在出图之前发现这类毛病。它查得出“组徽的字撑出了圆圈”吗？
5. 给你供模型的公司，自己出了和你抢生意的产品。如果你是那家设计工具公司的负责人，你手里还剩什么是对方拿不走的？

## 来源

1. 图层与 Photoshop 3.0（1994 年）据英文维基百科“Layers (digital image editing)”条目；SVG 的性质与 2001 年成为 W3C 推荐标准据“Scalable Vector Graphics”条目。
2. DALL·E 2（2022 年 4 月 6 日公布；其文字“像梦话”）、DALL·E 3（2023 年 10 月进入 ChatGPT，文字更连贯）据英文维基百科“DALL-E”条目；Midjourney（2022 年 7 月 12 日公测，在 Discord 里用命令，一次四张；第六版 2023 年 12 月）据“Midjourney”条目；Stable Diffusion（2022 年 8 月 22 日，代码与权重公开，消费级显卡可运行）据“Stable Diffusion”条目。
3. 《太空歌剧院》（2022 年 8 月 29 日获奖，至少 624 次提示与修改，评委的说法，2023 年 9 月 5 日版权局复审委员会的认定）据英文维基百科“Théâtre D'opéra Spatial”条目。“人的投入太少”是对认定理由的通俗转述。
4. Firefly（2023 年 3 月公测；训练数据的说法；2024 年 4 月彭博社的报道）据英文维基百科“Adobe Firefly”条目；接入 Photoshop 的时间据条目所引 The Verge 2023 年 5 月 23 日报道的标题，“圈一块说一句”是对这项功能的概括。
5. 2025 年 3 月 25 日的图像生成（自回归；首周 1.3 亿用户、7 亿多张图；动画风格的流行）据英文维基百科“GPT Image”条目；“Nano Banana”（2025 年 8 月 26 日发布，多轮修改保持主体一致）据“Gemini (language model)”条目。“从噪点里显影”“一小块一小块往下画”是对两类做法的通俗说法。
6. Figma Make（2025 年 5 月 7 日）、2026 年 2 月经 MCP 接入 Claude Code 与 Codex、2026 年 4 月董事辞任，据英文维基百科“Figma”条目；Canva 2025 年 10 月的设计模型、2026 年 4 月的 AI 2.0 研究预览、8 月下调增长预期、11 月裁员 1271 人（22%），据“Canva”条目。S. Yin 等, Qwen-Image-Layered: Towards Inherent Editability via Layer Decomposition, arXiv:2512.15603，2025 年 12 月。这些条目记的是很近的事，可能还会改。
7. “早期修图软件里字和背景长在一起”是概括说法，没有逐项核对出处。Canva Magic Studio 与 Figma 2024 年部分功能的撤回细节未核对到可靠一手来源，本篇未展开。
8. 本篇的图片均为实际生成：三张直接画的海报取自 2026 年 11 月对 OpenAI 图片接口（gpt-image-2）的调用，各只画了一遍；三份模板由商汤 Token Plan 兼容接口（senseaudio-s2-flash）写成，各只写了一遍，用 resvg 转成图片。像素比较用的是系统自带的 sips 和几行 Python，容差是每个颜色通道 24。六站里只有第四站和第五站做了实验。

> **延伸阅读**：[[附录｜探索拓展：AI 在各行各业|返回探索拓展总览]] · [[第 14 章｜把“做出来”变成“交得出去”|回到《上册》第 14 章验收]] · [[下册第 01 章｜和模型说上话：Token Plan、流式输出、缓存与账本|前往《下册》动手实践]]
