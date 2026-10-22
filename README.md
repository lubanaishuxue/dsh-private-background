# @local/dsh-custom-background

给 DSH 换底图。图片、渐变、纯色三种来源，可调模糊、压暗、面板不透明度，**对话区与输入框各自独立一档**，以及字体颜色。

所有配置都在 **设置 → 插件 → 已安装插件 → 界面背景** 这一页，改完即时生效、自动保存。

**默认只改工作区**：左侧对话列表保持原样，不会被壁纸影响。想要整窗铺满，把「同时应用到左侧对话栏」打开即可。

图片只存在这台电脑上（IndexedDB），不会上传，也不会进入会话记录。

---

## 一、它到底做了什么

四层结构，从下到上：

| 层 | 载体 | 作用 |
|---|---|---|
| 壁纸 | `html::before` | 固定定位、`cover`、可模糊，`z-index:-1` |
| 压暗 | `html::after` | 黑色半透明蒙版，统一压全场亮度 |
| 语义 token | `body` → `frame` | 先把主题的 surface token 原值捕获下来，再在框架上重新混成半透明 |
| 面板 | 各组件 | 原本用 token 画底色，于是自动跟着变玻璃 |

关键在于**不是逐个组件改样式**，而是重定义语义 token。凡是用 `--dsw-alias-bg-base` 画底色的东西（三栏、会话容器、输入区、右侧面板）会一起变透明，不需要插件认得它们叫什么。

## 二、为什么左栏能保持原样

左栏（`.sidebarCol`）画底色用的是 `--dsw-specific-sidebar-fill`，**不是** `--dsw-alias-bg-base`。

所以作用范围是靠**遗漏**表达的，不是靠覆盖：

- 默认：`--dsw-specific-sidebar-fill` 压根不进重混列表 → 左栏仍是主题原色，壁纸在它后面被完全挡住
- 打开「整窗」：把这一项加进重混列表 → 左栏一起变玻璃

这比「给左栏再加一条不透明覆盖规则」稳，因为不需要猜左栏内部还有哪些元素会透。

同理，底部状态栏 `[data-shell-bottom]` 横跨整个网格宽度，在只改工作区时会漏出左栏下方的壁纸，所以它单独被钉回主题底色；整窗模式下则不处理。

**顶部标题栏属于窗口外壳，不属于工作区，所以只改工作区时它保持布局原本的样子：整条铺侧栏色。** 布局把拖拽区画成框架上的 `::before`，铺的就是侧栏色；插件不动它，左栏和标题栏读起来是一整块连续表面，工作区从它下沿开始才是壁纸。

这里曾经用过渐变：到侧栏宽度为止是侧栏色，之后透明，让壁纸从工作区一直顶到窗口最上沿。它只在侧栏展开时成立——布局发布的是侧栏**轨道宽度** `--dsh-windows-sidebar-width`，侧栏一折叠这个值就变成 `0px`，渐变的色标全落在 0 上，整条通栏立刻退回成「全屏壁纸条」，也就是 v2.1.0 当初要修掉的那个现象。**收起侧栏就会复现，所以那个写法等于没修完。** 同一条规则还有第二个毛病：设置页会把自己强制刷成不透明，透明通栏压在深色页面上就是一条亮带。

现在只有整窗模式才把通栏打透——那时外壳本身也是玻璃，壁纸本来就该铺满整窗。

## 三、对话区和输入框为什么各自一档

面板和正文的诉求是相反的：外壳越玻璃越好看，正文越实越好读。一个滑杆只能取中间值，两边都不满意。

两处各自覆盖自己的 token，而不是在已有底色上再叠一层——两层半透明会合成一个谁都没设过的数，滑杆就没有手感了。

| 位置 | 覆盖点 | 默认 |
|---|---|---|
| 对话区（中间那一栏） | `--dsw-alias-bg-base` | 78% |
| 输入框（`[data-composer-card]`） | `--dsw-specific-input-major` | 85% |

输入框给得更高，因为它是全屏唯一一处**壁纸正压在你要打的字下面**的地方：亮色斑块透过来，读起来像渲染故障，而不像设计。`[data-composer-card]` 正好打在画底色的那个元素上，所以只覆盖一个 token 就够——自定义属性声明在元素上，对该元素自己的声明同样生效，不需要再补一条 `background`。

### 液态玻璃

磨砂玻璃按归属分四类，因为这几类表面的性质不同：

| 档 | 谁 | 什么时候开 |
|---|---|---|
| 转写区 | 文件卡片、交付卡片、代码块、**内联 code 芯片**、**用户消息气泡** | **常开** |
| 输入框 | `[data-composer-card]`（模糊挂在 `::before` 上，见下）、底部状态栏、头部那排胶囊、底部那颗**「费用明细」胶囊**、**「回到最下面」圆钮** | 跟随「质感」开关 |
| 侧栏 | 新会话按钮、**历史记录背后那一块（随对话增长）**、左下角计费器 | 只在**整窗**作用域下开 |
| 右侧栏 | `[data-sidebar-right-panel]`（dockkit 的整列），下层 pane 停止画底色 | 跟随「质感」开关 |
| 菜单 | 所有走宿主菜单原语的弹出菜单（`/` 命令菜单、模型选择等） | 常开（深色玻璃，模糊与填充**临时可调**，见下） |
| 浮层 | 工作区悬停卡、短提示 tooltip | 常开（**深色**玻璃，字色写死成白，见下） |

**侧栏历史记录：一块随对话增长的背景，行保持平的。** 宿主平时不给这些行铺任何底色，只有 hover / 选中时上一点 `--dsw-alias-interactive-bg-hover`。压在壁纸上，整列标题就是「浮在画上的散字」。四种做法里只有最后一种同时满足「有底」和「不难看」：

1. **每行一块圆角填充** → 「一串药丸」。行距只有 2px（宿主 `_flatList > * + *`），文件夹和会话一样重；顺手覆盖宿主的 hover / `._selected` 还会让选中的那条最看不出来。
2. **撑满整列的面板**（`flex: 1`）→ 短列表下面拖一大块空板子。
3. **加厚整列自己的填充**（`--dsw-specific-sidebar-fill` + 24）→ 侧栏变成一块平的黑板，壁纸全丢了。
4. **正解：一块按内容收缩的背景。** 行一个字都不碰，只给 `[class*="_treeBody"]` 铺底。

收缩靠两行 flex，缺一不可：

```css
[class*="_treeBody"] { flex: 0 1 auto; }
[class*="_treeBody"] [class*="_list"] { flex: 0 1 auto; }
```

第二条不是冗余：宿主 `_list` 是 `flex: 1`，也就是 `1 1 0%`，**`0%` 的 basis 在 auto 高度的父容器里会解析成 0**，块会塌成只剩内边距。改成 `auto` 之后，块的基准高度才是内容高度，长列表再靠 shrink 收缩并滚动。

**三样东西共用一对边。** 侧栏里纵向排着新会话按钮、历史块、计费器，它们原本是三个宽度：

| 元素 | 宿主几何 | 处理 |
|---|---|---|
| 新会话按钮 | 侧栏 12px 内边距里再 `margin: 0 2px`（Windows 上宿主把它改成 `margin-left: 0`） | 基准，不动 |
| 历史块 | `_listArea` 用 `-12px` 负边距把容器**自身**撑宽 | `margin-left: 2px` + `margin-right: calc(var(--dsh-session-list-edge-inset) + 2px)` |
| 计费器 | 自己是**行向** flex 的 item，插件写了 `width: 100%` 才有整宽 | `width: calc(100% - 2px)` + `margin-left: 0`（非 Windows 用 `calc(100% - 4px)` + `margin-inline: 2px`） |

块的右边要多补一个 `edge-inset`：只写 2px 会让它正好比按钮宽 12px（复刻页量过）。

**计费器的宽度必须明写，不能交回 `auto`。** 这条踩了三版：v2.16 是 `width: 100%` 再叠 `margin-inline: 2px`，溢出 4px；v2.17 为了不溢出改成 `width: auto`，结果**右边短了 28px**。

原因在它的父容器：计费器注册进 `sidebar.footer.action` 槽，宿主给那层写的是 `_footerActions { display: flex; width: 100% }`——**行向** flex。行向 flex 的 item 主轴是横向，`width: auto` 就是「收缩到内容宽度」，于是卡片只包住最长那行「⚡ 平价 剩余 12时56分 周五 09:00 转峰时」。插件自己那条 `width: 100%` 正是为此而写：百分比对着 `_footerActions` 的内容盒解析，也就是侧栏的整个内容盒。

所以正确写法是**保留宽度、把按钮的 margin 减掉**：

```css
.cm-footer-stack.summary:not(.rail) { width: calc(100% - 4px); margin-inline: 2px; }
html[data-windows-titlebar] .cm-footer-stack.summary:not(.rail) {
  width: calc(100% - 2px); margin-left: 0;   /* 宿主在 Windows 上把按钮 margin-left 归零了 */
}
```

用百分比而不是像素，是因为它跟按钮**对着同一个包含块**解析，插件不需要知道侧栏有多宽。

窗口截图的实测（150% 缩放，除以 1.5 得 CSS px）可以逐条对上：

| 元素 | 左 | 右 |
|---|---|---|
| 新会话按钮 | 12.7 | 265.3 |
| 历史块 | 14.0 | 266.0 |
| 计费器（v2.17 `auto`） | 14.0 | **237.3** ← 差 28 |
| 计费器（`calc(100% - 2px)`） | 12.0 | 264.0 ✓ |

侧栏内容盒宽 254，按钮 `0 2px` 后是 12..264.7；`calc(100% - 2px)` = 252，从 12 起画到 264。复刻页探针输出 `左差 0px / 右差 0px`。

另外两个细节：

- 块要 `padding: 6px 0`。`_list` 是按**矩形**裁内容的，贴着块边缘的那一行一旦 hover，自己的直角就会从块的圆角里戳出来（8px 圆角在 y=6 处弧只内收 0.25px，所以 6px 够）。
- 宿主那条 `_fade`（24px 渐隐，钉在 `_treeBody` 底部）要**关掉**。在宿主布局里它在整列底部，离最后一行很远；块一收缩，它就正好压在最后一个会话上白掉一层。

所以 `[class*="_sessionRow"]` / `[class*="_projectRow"]` / `[class*="_searchResultRow"]` **一条规则都没有**——任何行级背景都会把宿主的选中态盖掉。

**菜单的模糊从来没真正工作过——这才是「正文穿过菜单」的真因，而且真凶在祖先。**

宿主把底色和模糊都画在内层 `[class*="_material"]` 上（`--dsw-menu-surface-fill`，暗色下 `#43454a73`，**只有 45%**；`--dsw-menu-backdrop-filter: blur(40px) saturate(150%)`）。看起来这是唯一该动手的地方，实际上怎么调都没用。

`backdrop-filter` 会创建一个 **backdrop root**，后代的 `backdrop-filter` 只能采样这个 root **内部**已经绘制的内容。而 `/` 命令菜单是 **`[data-composer-card]` 的后代**，输入框卡片以前套的是 `glassPane`，带 `backdrop-filter` —— 卡片因此成了 backdrop root。菜单挂在 `bottom: calc(100% + 4px)`，**整个在卡片边界之外**，采样区域是空的。

于是宿主那句 `blur(40px)` 一直在采样一个空盒子。菜单的真实表现就是一块 45% 的平色板，背后的正文原样穿过来。**没有任何填充比例能补偿一个不存在的模糊**——把填充从 45% 推到 76% 只是在给一个坏掉的模糊打补丁，而「液态玻璃感不强」正是这个补丁的副作用。

对照实验（`diag/ancestor-isolation.html`）把这件事钉死了：两栏的菜单规则一字不差、都是 45% + `blur(40px)`、都挂在卡片上方 100% + 4px，**唯一变量是卡片自己有没有 `backdrop-filter`**——

| | 卡片带 `backdrop-filter`（旧） | 卡片不带（新） |
|---|---|---|
| 菜单背后 | 人像、栏杆、窗框**清清楚楚** | 糊成一片柔和色块 |

> **⚠️ 一个被证伪的假设，别写回去。** 最先怀疑的是 `._surface` 那句 `isolation: isolate`——它也是 backdrop root 的常见成因，看起来完美。但拿同结构的对照页实测，**Chromium 并不会因为 `isolation` 就隔离 backdrop 采样**，三栏全都正常糊。所以修复里没有 `isolation: auto`。教训：**`backdrop-filter` 失效时先查祖先链，再谈其他**；`isolation` 是嫌疑人但不是这个案子的凶手。

修法只有一条：**`composerGlassCss` 不再调 `glassPane`，手写一份不带 `backdrop-filter` 的配方。** 视觉代价接近零——壁纸在 `html::before` 早就糊过了，卡片只丢掉 160% 的饱和度，填充、描边、内高光全留着。

另外把玻璃从材料层挪到了**表面**（`[data-menu-material]`）上，理由朴素：材料层是 `z-index: -1`，宿主只要给表面加一点背景就把它盖住；而且一层同时出 fill 和 blur 少一个合成层。材料层则彻底让位（`background: transparent` + `backdrop-filter: none`），不重复画。

**`/` 命令菜单还多一个问题**：`_menu` 自己**一点底色都没有**（`max-height:400px; box-shadow; padding:4px; position:absolute; bottom:calc(100% + 4px); left:0; right:0; overflow:hidden`，没有 `background`、没有 `backdrop-filter`）。所以它必须自己把 `background` 和 `backdrop-filter` 一起带上。

`[data-overflow-below]::after` 那条渐隐遮罩也得跟着改：宿主拿不透明的 `--dsw-specific-menu` 渐到透明，压在玻璃上就是一道黑边。圆角和 `--dsw-elevation-prominent` 都留给宿主，仍然读得出浮在页面上。

**输入框怎么既能模糊、又不弄死菜单？** 把模糊挂到 `::before` 上。

卡片是 `/` 菜单的祖先，卡片**自己**一旦有 `backdrop-filter` 就成了 backdrop root，菜单的采样被切断（上一节）。但卡片想要玻璃感，就需要真模糊。解法是拆成两层：

```css
[data-composer-card] { isolation: isolate; background: transparent; backdrop-filter: none; }
[data-composer-card]::before {
  content: ""; position: absolute; inset: 0; z-index: -1;
  border-radius: inherit; pointer-events: none;
  background: color-mix(... fill%);
  backdrop-filter: blur(Npx) saturate(160%);
}
```

卡片只需要成为 stacking context，好让伪元素的 `z-index: -1` 落在卡片背景之上、内容之下 —— `isolation: isolate` 正好干这个，而**实测它不会隔离 backdrop 采样**。伪元素是叶子，带模糊没有任何副作用。

对照页 `diag/card-pseudo.html` 把两种写法并排放：卡片自己带模糊 → 卡片糊了但**菜单背后清清楚楚**；模糊挂 `::before` → **卡片和菜单同时糊**。**两个属性一个安全、一个致命，别搞混。**

**右侧侧边栏**（dockkit）结构是反的：`[data-sidebar-right-panel]` 这个根是个裸的 `position: absolute` 盒子，**自己一点底色都没有**，可见的面画在更下层的 `[data-dockkit-host]` / `[data-dockkit-pane]` 上。所以玻璃铺在**根**上，然后把下面几层的 `background-color` 设成 `transparent` —— 否则宿主的填充会盖在玻璃上，什么都透不出来。

**而且必须用 `[data-sidebar-right-open]` 把它门住。** 这个根是**常驻**的：侧栏收起时它照样占着那一列的宽度，只是把内容 `transform: translateX(var(--dsh-sidebar-width))` 推走 + `visibility: hidden` 藏起来 —— `visibility` 不影响布局。所以无条件给根铺底色，就会在侧栏根本没打开的时候糊一大块玻璃盖在对话上（实测就是这样翻的车）。`data-sidebar-right-open` 是宿主在打开期间挂的布尔属性，门住它。

填充和模糊这两个数字现在由菜单、输入框、右侧栏**共用**（`menuFill` / `menuBlur`）。它们是同一种材料，必须一起动；只把菜单调好看、让输入框停在另一个不透明度上，正是「一眼看出是拼起来的」那种效果。

**填充量到多少合适？** 下面这张表是在**模糊还死着**的前提下量的（壁纸亮部 + 13.5px 正文）——所以它量的是「没有模糊时，多厚的色板才能压住字」，不是玻璃的参数：

| 填充 | 合成底色 | 正文对比度 | 面板亮度 / 起伏 |
|---|---|---|---|
| 100%（不透明） | `#232324` | 8.5:1 | 35 / **0.00** |
| **76%（当前默认）** | `#303c45` | **6.1:1** | 63 / 12.5 |
| 62% | `#374b58` | 7.1:1 | 79 / 20.0 |
| 45%（宿主原值） | `#4f6c80` | 3.0:1 | 113 / 28.4 |

62% 的对比度反而比 76% 高（底色更亮、白字更亮）——**只看对比度会选错档**。当时的判据是「背景大字能不能被抹掉」：壁纸上那行 60px 的时钟，40px 模糊下抹不掉，62% 能看见鬼影。**但那个「抹不掉」本身就是模糊失效的症状**——模糊真工作之后，40px 连 60px 的字都能抹平。所以这张表只能当「最坏情况的下限」看，真实取值交给滑块量。

> **⚠️ 这两个数字目前是临时可调的。** 上面那张表是拿复刻场景量出来的，但真实壁纸千差万别，而且**填充和模糊是一对，不能单独调**：半径越大背景磨得越平，压住文字所需的填充就越少，而填充越少才越像玻璃。40px 恰好是「壁纸已经糊成一片平色、认不出形状」的那一档，这既是当初被迫把填充推到 76% 的原因，也是「玻璃感不强」的另一半。所以设置页上并排放了两条滑块：
>
> - **菜单背景模糊（临时）** — `settings.menuBlur`，0–64px，默认 40（宿主真值）
> - **菜单玻璃填充（临时）** — `settings.menuFill`，20–100%，默认 76
>
> 拖到满意之后，固化步骤是：把两个数字写进 `DEFAULTS.menuBlur` / `DEFAULTS.menuFill`，然后删掉 `ConfigPage` 里那一节滑块和 `TEXT` 里的 `menuBlur` / `menuBlurHint` / `menuFill` / `menuFillHint` 四条。`menuSurfaceCss` 继续读这两个 setting 不用动，`readSettings` 的 clamp 也保留 —— 这样老用户 localStorage 里存的值会被静默夹到合法区间，不会因为滑块消失而出错。
>
> 冒烟测试里有三条专门盯这条链路：`menu fill follows the slider`、`menu blur follows the slider`、以及两条 clamp 下限/上限。它们是拆滑块时唯一会提醒你「别再改回写死字面量」的闸 —— 因为默认值恰好就是那两个数，其他断言在写死的情况下照样全过。

**转写区常开**：它们是内容不是外壳，压在工作区的壁纸上面。一块实色卡片铺在壁纸中间，读起来就是画面上打了个洞。所以「质感」切回实心只说明输入框要实心，不该连带把整篇对话里的代码块和文件卡都拉回实色。

**有一类表面必须钉回不透明：悬停预览卡。** 转写区右侧那排小标记，悬停时会弹出「这一问 + 三行回答」的预览卡（`xpvNua_preview`），它画的是 `--dsw-alias-bg-layer-1`，而这个 token **在**重混列表里，于是卡片掉到面板那一档的透明度，背后的正文原样穿过来——预览看不清，被它盖住的那段正文也看不清。预览卡是唯一「透明度不是风格而是 bug」的表面，所以用捕获下来的原始 layer 值钉回去；卡片自己的圆角和 `--dsw-elevation-panel` 都留着，仍然读得出浮在页面上。

**悬停卡和 tooltip 反过来——它们是「反色表面」，只能做深色玻璃。**

工作区那一行悬停 0.8 秒会弹出「工作区名 + 路径 + 创建时间」的卡（`WorkspaceHoverCard`），短提示（快捷键那种）是另一个 `_bubble`。两者在壁纸上都是**纯黑实心**，因为：

- 悬停卡把颜色**写死在元素自己身上**：`._card_38jqx_9 { --dsw-hovercard-bg: #2C2C2E; background: var(--dsw-hovercard-bg) }`
- 卡里的字也写死：`_hoverTitle` 是 `#fff`，`_hoverPath` / `_hoverTime` 是 `#cfd3d6`
- 短提示画 `--dsw-alias-tooltip-bg`，暗色下是 `--dsw-static-neutral-bluish-850`，同样是静态值

两个 token 都不在 `SURFACE_TOKENS` 里，重混够不到——跟「费用明细」胶囊、内联 code 芯片是同一个盲区。

**但这次不能钉回不透明，也不能转浅色玻璃**：字色写死成白色，底色一浅就糊了。能做的是**深色玻璃**——保留宿主自己的颜色，只把 alpha 拿掉，再用 `backdrop-filter` 把背后磨平：

```css
body > [class*="_card_"] {
  background: color-mix(in srgb, var(--dsw-hovercard-bg) 74%, transparent);
  box-shadow: var(--dsw-shadow-lv3), inset 0 0 0 1px rgb(255 255 255 / 0.10);
  backdrop-filter: blur(12px) saturate(150%);
}
[class*="_bubble_"][data-side] {
  background: color-mix(in srgb, var(--dsw-alias-tooltip-bg) 82%, transparent);
}
```

三个要点：

- 写成 `color-mix(<宿主自己的变量> N%, transparent)`，不是写死十六进制。这样它**跟着宿主调色板走**，两套主题都不用改，宿主改色也跟着改。注意这里改的是 `background` 而不是变量本身——变量还是宿主的原值，所以不存在自引用。
- **74% 是可用性下限，不是口味。** 卡宽 244px，里面是 12px 的 `#cfd3d6` 路径文字；低于 ~70% 壁纸自己的高光就会跟字抢对比度，跟转写区气泡在 22% 上踩的是同一个坑。短提示只有一行 13px 字，给 82%。
- 描边用 **inset 阴影**，不用 `border`。卡片是 `box-sizing: border-box` 的固定 244px，1px 边框会啃掉正文宽度。

选择器收口：`body > [class*="_card_"]` 是因为 `HoverCard` 原语把它 `createPortal` 到 `document.body` 上，正好是 body 的直接子节点——裸 `_card_` 会误伤不是 tooltip 的卡片。短提示用 `[data-side]` 限定，那是 tooltip 原语一定会写的定位属性，消息气泡没有。

**气泡走常规 pane 配方。** 它跟文件卡、代码块同属转写区内容，22% 填充 + 磨砂。**不要**单独给它加重填充——气泡是用户消息，压在正文上面只是滚动时的瞬时重叠，加重了反而跟整篇对话的玻璃不一致。

**代码块有三处各自画底色**，少清一处就会留下一条实心色带：`_block` 和 `pre` 画 `var(--dsl-code-block-background)`，标题栏 `_banner` 画的是另一个 `var(--dsl-code-block-banner-background-color)`。早先只清了外层的 `_bannerWrap`，所以「代码块」那条标题栏一直是实心深色。现在在 wrapper 上把这两个自定义属性都改成 `transparent` —— 它们是继承的，所有 `var()` 引用会一起失效，比逐个覆盖干净。

**侧栏跟着侧栏走**：只改工作区时左栏要保持主题原样，给一个不透明的面板磨砂没有意义——后面没有壁纸可折射，还会成为这一列里唯一被碰过的元素。整窗模式下左栏本身就是玻璃，这两块才跟着变。

**状态栏跟输入框走**：它就在消息框正下方，是同一坨外壳。实心模式如果只留它一条磨砂，那它就成了整个窗口里唯一一块玻璃——所以「质感」管到底。

每个表面都有稳定的钩子，都不靠猜哈希类名：

| 表面 | 钩子 | 为什么稳 |
|---|---|---|
| 输入框 | `[data-composer-card]` | 官方 data 属性 |
| 底部状态栏 | `[data-composer-dock]` | 官方 data 属性（宿主的 `InputBar.dock`） |
| 头部胶囊 | `[data-slot="conversation.session.header.actions"] button:not([class*="_trigger"])` | 槽位 data 属性；`_headerActions` 里只渲染这一个槽，所以「槽里每个 button」正好是标题旁边那一排。触发器排除，见下 |
| 团队面板 | `[data-team-panel]` | 宿主给面板根写的 data 属性；面板是 portal 出来的，槽位收口够不到它，见下 |
| 费用明细胶囊 | `[data-composer-dock] .cm-btn`（头部那颗用 `[data-slot="conversation.session.header.actions"] .cm-btn` 隐藏） | 槽位 data 属性 + 计费器自己的类名 |
| 用户气泡 | `[data-chat-flow-kind="user"] [class*="_bubble"]` | flow item 的 data 属性 + 本地类名 |
| 回到最下面 | `[class*="_toBottom"]:not([class*="_toBottomSlot"])` | 类名是 `<hash>_toBottom`；外层槽位是 `<hash>_toBottomSlot`，`$=` 天然区分，`:not()` 是防以后加第二个类名 |
| 菜单 | **表面**：`[data-menu-material]`（命令菜单再加 `[class*="_menu"]:has([class*="_itemDescription"])`）；**材料层**：`[data-menu-material] > [class*="_material"]` 让成 `transparent` + `backdrop-filter: none` | 原语写在菜单根上的 data 属性；命令菜单那条用「里面有没有那一列右对齐说明」收口。模糊能不能生效**不取决于这层**，取决于祖先有没有 `backdrop-filter` |
| 侧栏历史块 | `[class*="_treeBody"]`（内层 `[class*="_list"]`、`[class*="_fade"]` 一起收口） | 类名是 `<hash>_treeBody`，本地名稳定；**行本身一条规则都不加**，见上 |
| 悬停预览卡 | `[class*="_preview"]:has([class*="_previewResponse"])` | 好几个模块都用 `_preview` 命名，用「里面有没有 response 那行」收口 |
| 工作区悬停卡 | `body > [class*="_card_"]` | `HoverCard` 原语 `createPortal` 到 `document.body`，是 body 的直接子节点；`body >` 挡掉不是 tooltip 的卡片 |
| 短提示 tooltip | `[class*="_bubble_"][data-side]` | `data-side` 是 tooltip 原语的定位属性，消息气泡没有 |
| 代码块 | `[class*="_block_"]:has([data-code-block-banner])` | 类名是 `_block_<hash>_<line>`，`_block_` 这半截能跨版本存活 |
| 附件卡 | `[class*="_fileCard"]` | 类名是 `<hash>_fileCard`，`_fileCard` 是稳定那半截 |
| 交付卡 | `[data-presented-file]`（备用：`[class$="_file"]:has(> [class$="_fileBody"])`） | 见下 |
| 内联 code | `[class*="_markdown_"] :not(pre) > code` | 类名是 `_markdown_<hash>_<line>`；末尾那个下划线把 `_markdownPreview` 挡在外面 |
| 新会话 | `[class$="_newSession"]` | 类名是 `<hash>_newSession`；必须用 `$=`，见下 |
| 计费器 | `.cm-footer-stack.summary:not(.rail)` | 插件自己的类名，不是哈希 |

**状态栏为什么原来像一行散字。** `[data-composer-dock]` 自己不铺任何底色——它只是把 `conversation.composer.dock` 槽和右侧的上下文计量表（34% 那个环）摆成一行，所以转写区的文字会直接从它下面穿过去。铺一块面板之后它才真正读作「状态栏」，而不是贴着窗口边的一行无主文字。它原本 `padding-top: 4px`、下边距为 0，字是贴着底边压的，所以面板化时把内边距补成对称的 `3px 8px`，外加 `box-sizing: border-box` 免得 16px 横向内边距把盒子撑出容器。

**「费用明细」为什么一直是黑胶囊。** 它是计费器自己的 `.cm-btn`，画 `var(--dsw-alias-button-elevated-fill)`。这个 token 不在 `SURFACE_TOKENS` 里，而且暗色主题下它解析成**静态中性色 `#43454a`**——重混只改写 token，够不到一个静态值，所以它从头到尾没被碰过。这里跟内联芯片的唯一差别是**边框保持宿主的 1px**：按钮是块级元素，把它削到 `.5px` 只会让一条本来不该动的边变细，而内联芯片那套 `0.5px` 是为了避免行内重排才必须的。

**头部那颗费用明细是藏掉的，不是磨砂的。** 计费器把同一个按钮注册了两处：一处是会话头部（`conversation.session.header.actions` 槽），一处是底部状态栏。同一行数字出现两遍是重复信息，只留下面那颗，所以头部那条规则整句是 `display: none !important`。

它**不受「质感」开关管辖**——这不是装饰，是「一颗按钮出现了两次」这个问题的修复，实心模式下也不该冒出来，所以它写在 `costMeterCss` 里而不是 `statusGlassCss` 里。计费器自己有个 `hideSessionCostHeader` 配置键做同一件事，但那个值存在它自己的 ledger 里、每次用量 tick 都会重写，手改的值撑不到下次启动。选择器收口在头部槽上，底部那颗和统计弹窗里的都不受影响。

**团队面板为什么不能用槽位收口。** 面板是 `createPortal` 渲染到 `document.body` 的，**不是** `conversation.session.header.actions` 的后代——`position: fixed` 只改变它画在哪里，但这里连 DOM 位置都换了。所以 `[data-slot="…header.actions"] button[class*="_member"]` 一个元素都匹配不到，规则静默失效，成员卡照旧是一块黑。宿主在面板根上写了 `data-team-panel`，这才是那个能用的钩子，而且它比哈希类名活得久。

面板本身宿主已经磨砂过了（`--dsw-specific-menu` + `--dsw-menu-backdrop-filter` 画在 `::before` 上），但里面有两处画 `--dsw-alias-bg-layer-2`——成员卡和任务卡——在透光的面板里就是两个黑洞。

**参照物是旁边的子智能体面板**：它的行完全透明，只有 hover 有底色，别的什么都没有。所以成员卡**干脆不要填充**（`background-color: transparent`），连宿主的 `--dsw-elevation-stroke` 一起去掉，只在 hover / 键盘聚焦时给一层 9% 的底色；当前会话那张卡保留宿主自己的 business-primary 内描边，否则「哪张是当前会话」就没有标记了。

> 中间试过给成员卡套芯片配方（重填充 + 发丝边 + 顶部内高光），**结果是一块深藏青**。原因：芯片的填充是 `color-mix(--dshbg-raw-base 45%)`，而 `--dshbg-raw-base` 是由壁纸亮度推出来的——壁纸偏暗时「芯片」就成了深色块。没有填充就没有这种失败模式。

任务卡保留一层淡色（面板内整体重混 `--dsw-alias-bg-layer-2` 到 62%），因为它是一整块正文而不是一行。成员卡选择器是 `button[class*="_member"]`：卡的子节点叫 `_memberName` / `_memberText` / `_memberDot` / `_memberModel`，当前那张还带 `_memberCurrent`，`$=` 和裸 `*=` 都选不中；只有卡自己是 `<button>`，这条也顺手把 workflow 面板的 `_memberButton` 挡在外面。

**头部那排胶囊为什么用一个槽就能全选中。** `_headerActions` 这个容器里只渲染了 `renderSlot("conversation.session.header.actions")` 一个东西，所以「这个槽里的每个 button」正好等于「标题旁边那排」：智能体团队、标准模式、4 个子智能体。它们全都是宿主用 `background: 0 0; border: 0` 画的纯文字按钮，铺上玻璃才从一排散字变成一排面板。这些按钮本来没有边框，所以给的是芯片那套 `.5px` 发丝边。触发器（`_trigger` / `_switcherTrigger`）用 `:not()` 排除掉——给一个开下拉的按钮常驻一块底色，读起来像「按下去没弹起来」，玻璃应该只出现在弹出来的面板里。

**用户气泡是内容，所以常开。** 它画 `--dsw-specific-bubble`，同样不在重混列表里，暗色主题下就是一块不透明深灰。归属跟文件卡、代码块一致：它属于转写区，所以「质感」切回实心不影响它。选择器用 flow item 的 `data-chat-flow-kind="user"` 收口——`_bubble` 这个本地名在别的模块里也有（轨迹、终端），不加这层限定会误伤。

**交付卡为什么要这么绕。** 它画的是 `var(--deliverable-fill)`，而那是 `--dsw-static-neutral-850` ——**静态中性色，不是语义 token**，所以 token 重混这条路径根本够不到它，卡片一直是实色。只能整块铺玻璃。但光写 `[class$="_file"]` 会误伤另外两个同名尾巴：输入框里 24px 高的附件片（`v1kfCW_file`）和变更文件行（`PWz36q_file`），给它们套玻璃只会变成两块怪斑。交付卡自带一个 `_fileBody` 直接子节点，另外两个没有，于是用 `:has(> …)` 把它挑出来。首选钩子其实是卡上的 `data-presented-file`，类名那套留作后备。

**内联 code 芯片是另一套配方，不是缩小的面板。** 它画的是 `--dsw-alias-markdown-inline-code`，同样不在重混列表里，所以一直是实色芯片。跟大面板比改了三处，全是因为它只有 20px 高、一屏出现几十次：

- **填充更重**（45%，面板是 22%）。芯片必须跟正文区分开，22% 会直接糊进壁纸，那串等宽字就不再像一个 token 了。45% 是 12px 等宽字在亮色 label 下还能守住 5:1 的地方——再低就只剩好看。
- **去掉投影**，只留顶部内高光。一段话里飘十几个投影纯属噪音，发丝边已经足够把它从页面上托起来。
- **模糊封顶 10px**。背景本来就在 `html::before` 上糊过一遍，更大的半径买不到观感，只会乘以屏上芯片数量。
- **边框保持 `.5px`**，只换颜色。改成 1px 会让每个芯片的盒子各胖 1px，而它们是内联元素——一段话里上百个芯片就是上百次行内重排。

**`$=` 和 `*=` 不是可选项。** 新会话按钮的类名是 `<hash>_newSession`，用 `[class*="_newSession"]` 会把它的四个子节点一起选中——`_newSessionContent`、`_newSessionLabel`、`_newSessionLabelMask`、`_newSessionShortcut` 全都含这个子串，结果是标签和快捷键提示各自套上一层边框和投影。类名是整串匹配（元素只有一个 CSS module 类名），所以 `[class$=…]` 才是精确的那个。

代码块的 banner 和 `pre` 各自会再画一遍块底色，两处都要清空，否则磨砂只做了一半——四周是玻璃、中间一块实心。

壁纸本身在 `html::before` 上已经糊过了，所以面板自己的 `backdrop-filter` 主要是补饱和度、给边缘定形，不是靠它做模糊。这样长对话里几十个代码块也不会把 GPU 拖死。

> 已知边界：`backdrop-filter` 会给 `position:fixed` 的后代改定位基准。输入框模块里没有 fixed 元素（查过），但宿主以后若在里面塞浮层，可能出现偏移。新会话按钮在侧栏收起时是 `position:fixed` 的悬浮按钮，它自己没有定位后代，所以安全。

### 标题：放得下就不滚，放不下才滚

会话标题是面包屑，宿主封顶 `max-width: 220px` + `text-overflow: ellipsis`，长名字从第 220px 起就没了。

**这个 220px 是宿主为了「截断 + 省略号」定的，不是布局真的只给得出这么多。** 头部是 `_titleCluster{flex:1}` 装着 `_headerLeading`（面包屑）和 `_headerActions`（右侧胶囊），标题旁边经常有一大片空着的宽度。原样留着这个上限，一个 232px 的标题在一个空了大半的头部里也会**永远滚下去**——它从来没被允许用旁边的空间。

所以先放宽、再判断：

1. 按头部真实余量算 `room`：`_titleCluster` 的宽度减去右侧胶囊、减去间距，再减去面包屑行里不属于这条标题的部分（分隔符、第二段）。
2. 把 `max-width` 设成 `room`（按 `box-sizing` 折算）。**只在值变了才写**。
3. 再量 `shift = 文字宽 - 内容宽`。`shift < 2` 就 `stop()`，完全不滚；否则才挂动画。

`max-width` **不能**跟着「这条放得下」一起被摘掉：摘掉就回到 220，于是又放不下、又开始滚、再套回 `max-width`——两帧一次的自激。只有壁纸关掉时才还原（`reset()` 负责，`stop()` 不碰）。

滚动那一半的要点：

- 动的是 `text-indent` 而不是 `transform`。要动的是元素**内部**的文字；`transform` 会把整个盒子——连悬停底色和点击区域——拖到旁边那几个胶囊上面去。
- **动效是 CSS 动画，不是 Web Animation**。WAAPI 的动画是 JS 持有的对象，任何一次重新 `sync()` 都能取消或替换它——而宿主会重渲染头部，标题节点被摘挂一次，挂在它身上的动画就被静默取消。声明式 CSS 在元素回到文档时由样式引擎自动重新生效，重渲染杀不死它。JS 只写三样东西：`data-dshbg-mq` 属性（开关）、`--dshbg-mq-loop`（距离）、`--dshbg-mq-dur`（时长），而且**只在值真的变了才写**——重写自定义属性会让动画从零重新开始。
- `paint()` 写样式表前会先比字符串。替换 `<style>` 的 textContent 等于把整张表重建，表里的 CSS 动画会全部从头开始。
- **单向匀速、无缝循环**：文字一直往左走，走完「文字宽 + 32px 间距」就回到起点，那一帧和出发那一帧像素级重合。循环距离用未取整的文字宽度算——取整会在每次接缝留下不到一个像素的跳动。
- 接缝靠 `::after` 复制一份文字：`content: attr(data-dshbg-mq)`。**不去碰 React 管的文本节点**——不复制的话每个循环有一半时间是空盒子。
- 距离用 `Range` 量文字本身。**`scrollWidth` 不能用**：复刻页实测，`text-indent` 从 0 走到 -240px 时它全程钉死在 491，根本不动，拿它当「动没动」的指标等于没量。
- 盒子用 `min-width` 钉住。`inline-block` 是 shrink-to-fit，而 `text-indent` 参与首行 max-content 计算——往左拉文字的同时也把盒子拉窄，`ResizeObserver` 于是重新触发，动画被自己重启。钉住的宽度要按 `box-sizing` 折算：`clientWidth` 含内边距，`min-width` 默认对 content box 生效，直接钉 `clientWidth` 会让标题框自己胖一圈。
- 重新测量的触发源只有标题自己：一个盯**面包屑导航**的 `ResizeObserver`，加一个**过滤过**的 `MutationObserver`。转写区每吐一个 token 都在改 DOM，全局监听会让跑马灯一秒重启几十次。
- 速度是常数 `45px/s`，距离只决定「要不要滚」，不决定「滚多久」。
- 面包屑的当前那一节是 `<span>`，祖先才是 `<button>`，两个都要选中。`_crumbSeg` / `_crumbSep` / `_crumbs` 也含 `_crumb` 子串，所以按名字排除，而不是靠层级位置猜。
- 关掉壁纸时动画跟着停，`data-dshbg-mq` 一起摘掉——因为配套的 `text-overflow: clip` 在激活作用域里，没有它，滑动的标题会一直把省略号钉在右边。
- 它把最后一次测量写进 `localStorage`（`dsh.custom-background.marquee.probe`，去重写入）。跑马灯是这个插件里唯一「坏了也看不出来」的部分：不滚的标题和刚好放得下的标题长得一模一样，而打包后的 App 没有 devtools。
- 判断「在滚 / 反复重启 / 根本没挂上」只能看 `getAnimations()`：`currentIteration` 换圈会 +1，被重启则不变；`startTime` 只有动画被丢掉重建才会动。`text-indent` 的瞬时值区分不了这几种情况。

## 四、设置页为什么是不透明的

壁纸压在标题后面就没法读了。但「哪一栏是设置页」不能靠猜 DOM。

做法是让**组件自己声明**：配置页挂载时给 `<html>` 打 `data-dshbg-config`，卸载时移除。样式表据此把壁纸覆盖的那部分铺成主题底色——只改工作区时铺中右两栏，整窗模式铺整个框架（否则左栏会变成设置页旁边的一条透光带）。

只认 `view === 'page'`，因为同一个组件在插件列表里也会以 summary 形式渲染一次——那种情况下不应该把整页刷实。

不透明铺在**栏**上而不是内容块上：页面容器是 `align-items:center` 的 flex column，内容块被限制在 `max-width:960px`，只铺内容块会在两侧各留一条透壁纸的亮缝，看起来像渲染 bug。

## 五、右上角那三个按钮是怎么改的

最小化 / 最大化 / 关闭**不是 DOM 按钮**。Electron 用原生 title-bar overlay 画它们，overlay 自己带不透明底色，所以任何针对框架的 CSS 都碰不到——这就是它们一直是块实色、周围全变玻璃的原因。

但 preload 留了一个口子。它往 `<body>` 里塞了一个隐藏探针：

```html
<span style="...;background-color:var(--dsw-specific-sidebar-fill);
             color:var(--dsw-alias-label-primary)">
```

然后读这个探针的**计算值**，通过 `dsh-desktop:windows-appearance` 发给主进程，主进程转手调用 `setTitleBarOverlay`。它还用 MutationObserver 盯着 `<head>` 的 childList / characterData——所以**插入这张样式表这个动作本身**就会触发重新取值。不需要 IPC 权限，插件关掉后主题色自动回来。

真正的 bug 在这里：探针是 `<body>` 的子节点，它在 `<body>` 上解析内联的 `var()`，**比 token 被重混的 frame 高一层**。所以它一直读到未经重混的、不透明的侧栏色。

修法只针对探针本身，不去 `<body>` 上重写 token——那样会把左栏一起拖下水，还会让同一元素上的 `--dshbg-raw-*` 捕获变成自我引用。符号色按壁纸实测明暗取，不跟用户的字体选择走：这是为了在图上看得见，不是阅读偏好。

## 六、字体颜色

| 模式 | 行为 |
|---|---|
| 跟随主题 | 什么都不改（默认） |
| 自动 | 把背景画到 16×9 离屏 canvas 上抽样 Rec.601 亮度，穿过「压暗」和「面板不透明度」两次折算，超过 140 用深色字，否则浅色字 |
| 浅色 / 深色 | 固定色板 |
| 自定义 | 指定主色，其余层级由 `color-mix` 推导 |

自动模式是**纯函数**：同一个亮度永远得到同一个色调，不参考上一次的结果。这不是风格问题——早期版本用了双阈值迟滞并且方向写反，导致色调反复翻转、每次翻转触发重绘、重绘又触发测量，事件循环被占满、进程假死。

## 七、代码结构

```
client.js
├─ 常量        DEFAULTS / GRADIENTS / SWATCHES / FONT_PALETTES
├─ 文案        TEXT.zh / TEXT.en
├─ 工具        clamp / currentLang
├─ 持久化      readSettings / writeSettings（localStorage）
├─ 图片库      openDb / dbRun / ingestFile（IndexedDB + 降采样到 2560px）
├─ 亮度        lumaOfCss / lumaOfImage / measureLuma / toneOf
├─ 状态        state + subscribe / commit / patchSettings
├─ 选择器      frameSelector / workAreaColumns / bottomRowSelector
├─ 样式        wallpaper / token / chatSurface / composer / glass / chrome / caption / bottomRow / font / configPage / costMeter
├─ 安装        installStyles（apply 内注入 <style>，ctx.effect 托管清理）
├─ 组件        Switch / Segmented / Slider
└─ 页面        ConfigPage（注册到 plugins.bundle.config）
```

## 八、踩过的坑（改动前务必看）

**1. 逗号列表不能共享前缀。**
`html[data-dshbg-on] a, b` 只给 `a` 加了前缀，`b` 退化成裸选择器、无条件生效。所有多选择器都必须走 `prefixed()`。冒烟测试里有一条全局断言专门查这个：遍历整张样式表的每个选择器，必须全部以 `html[data-dshbg-on]` 开头。

**2. 模板字符串里不要写 `/* */` 注释。**
注释里只要出现反引号就会提前终止模板，报 `ReferenceError` 或 `SyntaxError`。CSS 说明一律写成函数外的 JSDoc。

**3. 两个 `data-*` 都在 `<html>` 上时必须写复合选择器。**
`html[a] [b]` 是后代选择器，永远匹配不上。`data-dshbg-on` 和 `data-windows-titlebar` 就是这种情况。

**4. `rgb(from X r g b / 1)` 会吃掉透明度。**
`dsh-cost-meter` 1.9.x 的面板这么写，`/ 1` 把 alpha 强制拉满，往 token 里塞的透明度到不了屏幕。只能直接重定向它的 class（见 `costMeterCss`）。

**5. 亮度测量不能只在「自动」字体下跑。**
它现在有两个消费者：自动反调字体，和整窗模式下标题栏按钮的符号色。曾经门控在 `font === 'auto'`，结果默认字体下探针一直读到浅色符号。改成只要壁纸存在就测。

**6. 别把「当前状态」写进选择器之外的地方。**
标题栏渐变依赖 `--dsh-windows-sidebar-width`，而它表示的是侧栏**轨道宽度**，侧栏一折叠就归零——于是「到侧栏宽度为止」这个几何假设整条失效，而且失效方式是静默的（不报错，只是退回原来的样子）。凡是拿宿主发布的尺寸做几何，先问一句「它归零时是什么样」。

**7. 链接目录装的插件改完必须完全重启 DSH。**
`client.js` 已缓存进内存，HMR 不保证换代。

**8. 行向 flex 的 item 上，`width: auto` 等于「收缩到内容宽度」。**
计费器就在 `_footerActions { display: flex }` 里，`auto` 让它只包住最长那行文字，右边短 28px。想让它占满就得**明写宽度**，而且要用百分比对着包含块算（`calc(100% - 2px)`），不要写死像素。同理，`flex: 1` 在**列向**容器里是往竖着长，不能拿来当「横向拉满」的替代品。

**9. 静态色值一条规则改不完，得先看它写在哪一层。**
同样是「黑」，三种成因三种解法：写在内层 `[class*="_material"]` 上的（菜单，`--dsw-menu-surface-fill` 45%）→ 重定向该层的 `background`；写在 `SURFACE_TOKENS` 里的（预览卡，`--dsw-alias-bg-layer-1`）→ 钉回捕获的原始值，因为那张卡的透明度是 bug 不是风格；**写在元素自己身上并且带写死字色的**（悬停卡 `--dsw-hovercard-bg: #2C2C2E` + `#fff`）→ 只能做深色玻璃，`color-mix` 保留原色去 alpha。改之前先确认字色是不是写死的，否则「变浅」会把字糊掉。

**10. `backdrop-filter` 会创建 backdrop root，所以**别把它放在弹层的祖先上**。**
这是这一版最贵的一课，而且我一开始查错了方向。

`backdrop-filter` 会让元素变成 **backdrop root**，后代的 `backdrop-filter` 只能采样 root **内部**已经绘制的内容。`/` 命令菜单是 `[data-composer-card]` 的后代，卡片套了 `glassPane` 的 `backdrop-filter` → 卡片成了 root；菜单挂在卡片**外面**（`bottom: calc(100% + 4px)`），采样区域空 → 模糊完全无效。

症状极具迷惑性：菜单看着像「太透明」，于是所有人（包括我）第一反应都是去调填充。**但调填充是给一个不存在的模糊打补丁**，补丁的代价就是「玻璃感不强」——为了让 45% 的平色板压住字，只能把填充推到 76%，而 76% 几乎就是不透明。

**判据**：模糊「没效果」时，第一步不是调参数，是沿着 DOM 往上找有没有 `backdrop-filter` / `filter` / `opacity < 1` / `mask` / `clip-path`。叶子节点随便用，会拥有 popover 的容器不行。

**11. `isolation: isolate` 看起来像凶手，实测不是。**
`._surface` 带 `isolation: isolate`，按规范它也是 backdrop root 的成因之一，所以我第一版诊断就是它，还写了 `isolation: auto` 的修复。**拿同结构的对照页实测，Chromium 并不会因此隔离 backdrop 采样**——三栏（宿主结构 / 挪到表面 / 挪到表面 + 76%）全都正常糊。

结论：`isolation` 在 Chromium 里**不是** backdrop root 的触发条件（至少这个场景不是）。真凶是祖先的 `backdrop-filter`。修复里的 `isolation: auto` 已经删掉了——**别把一个基于错误诊断的改动留在代码里**，它会让下一个人以为那条路径是必要的。

## 九、改了代码之后

```bash
node tools/smoke-test.cjs
```

202 项检查，覆盖：模块契约、样式表注入、壁纸层、token 捕获与重混、**作用范围（左栏是否被重混）**、对话区与输入框独立不透明度、标题栏通栏、标题栏按钮探针、设置页及其作用域、液态玻璃五档归属与四套配方（面板 / 芯片 / 悬浮控件 / 深色玻璃）、底部状态栏、头部胶囊、用户气泡、费用明细胶囊与头部那颗的隐藏、回到最下面圆钮、侧栏历史块（随内容收缩、行一条规则都没有、三处边缘对齐、关掉宿主 `_fade`）、计费器宽度与 Windows 下的按钮内缩、悬停预览卡、菜单的玻璃画在表面而非材料层、材料层让位、**输入框卡片放弃 backdrop-filter 并把模糊挂到 `::before`**（模糊失效的真凶 + 卡片和菜单同时糊）、右侧侧边栏的玻璃（**只在打开时**）与下层停止画底色、悬停卡的填充下限、两条临时滑块是否真的驱动样式表及其上下限、悬停卡与 tooltip 的深色玻璃（描边不用 border）、团队面板（portal 与内层 token 重混）、代码块三处底色与标题栏、标题的「放得下就不滚」与 `max-width` 还原时机、选择器 / 测量方式 / 无缝循环 / 自激防护 / 声明式动效与关键帧、配置页实际渲染、五种字体模式、cost-meter 兼容层、生命周期、CSS 语法与选择器前缀。

`--dump` 可打印实际产出的 CSS：

```bash
node tools/smoke-test.cjs --dump
```

跑通后完全退出 DSH 再重开。插件页底部的 `样式 / 激活 / 框架 / 三栏` 四项能区分四类故障：样式表没注入、`<html>` 没标记、框架没定位到、栏数不对。

## 十、已知边界

- 作用范围靠结构定位（`nth-of-type` + `data-shell-*`），宿主大改布局会失效；失效时插件页会显示提示，且不影响其他界面。
- 只改工作区时标题栏整条是侧栏色。想让壁纸顶到窗口最上沿，就把作用范围切成整窗。
- 标题栏按钮的适配依赖 preload 里那个探针的 `style` 属性原文（用 `[style*="--dsw-specific-sidebar-fill"]` 匹配）。如果哪天 DSH 改成给探针加 class 或用别的变量，这条规则会静默失效——表现为按钮退回实色块，其他一切照常。整窗模式下符号色取的是整张壁纸的平均明暗，不看右上角局部，所以角落特别亮/特别暗时对比度可能不理想。
- 只处理插件管理器页面保持不透明；DSH 通用设置页未做处理。
- `costMeterCss` 依赖 `dsh-cost-meter` 的类名，对方改类名后该规则静默失效（不报错，只是卡片变回实色）。
