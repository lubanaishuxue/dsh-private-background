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
| 语义 token | `body` 捕获 → `body > *` 重混 | 先把主题的 surface token 原值捕获下来，再在下一层重新混成半透明 |
| 面板 | 各组件 | 原本用 token 画底色，于是自动跟着变玻璃 |
| 兜底 | `[data-dshbg-auto]` | 不跟 token 走的表面（插件写死颜色、伪元素遮罩），由 JS 探测器逐个找出、按原色降 alpha |

关键在于**不是逐个组件改样式**，而是重定义语义 token。凡是用 `--dsw-alias-bg-base` 画底色的东西（三栏、会话容器、输入区、右侧面板）会一起变透明，不需要插件认得它们叫什么。

**捕获和重混必须分在两层元素上**，而且捕获必须挂在 `body`（主题声明 token 的地方）、重混挂在 `body > *`（既读不到自己，又覆盖 `#root` 和所有 portal）——理由在第五节和第七节。这三条是这套东西的地基，也是最容易踩塌的地方：**挂错一次，整层变量会静默失效，而画面看起来「也像玻璃」。**

还有第四条，是 v2.27.1 补上的：**一个表面只能有一个画家。** 宿主习惯让外壳和根各画一次同一个 token（两层同色，实心时完全看不出来），半透明之后声明的 alpha 会变成 `1-(1-a)²` 落地——见第六节。

## 二、为什么左栏能保持原样

左栏（`.sidebarCol`）画底色用的是 `--dsw-specific-sidebar-fill`，**不是** `--dsw-alias-bg-base`。

所以作用范围是靠**遗漏**表达的，不是靠覆盖：

- 默认：`--dsw-specific-sidebar-fill` 压根不进重混列表 → 左栏仍是主题原色，壁纸在它后面被完全挡住
- 打开「整窗」：把这一项加进重混列表 → 左栏一起变玻璃

这比「给左栏再加一条不透明覆盖规则」稳，因为不需要猜左栏内部还有哪些元素会透。

### 但整窗模式下它有个下限

整窗模式把这一项放进重混，而它的 `lift` 是 0 —— 也就是说**左栏的不透明度就等于「面板不透明度」滑杆**。滑杆在 0 的时候，左栏画的是 0%，等于没画。

这不算「更玻璃」，这算消失：导航项、工作区分组、会话列表全都浮在照片上，彼此之间没有任何表面可以依附。所以 `--dsw-specific-sidebar-fill` 有一个 `SIDEBAR_FLOOR = 40`：

```js
const alpha = Math.min(100, Math.max(floor, surface + lift));
```

滑杆在 40 以下它不再变淡，以上照常跟随。

**40 是「读得出来」的那条线，不是「好看」的那条线，这一点是被打脸打出来的。**

第一版 40 是拿用户自己的截图，把 `#1b1b1c` 的纱按 0 / 20 / 30 / 40 / 55% 铺上去挑的。这个实验回答的是「40% 看起来什么样」，**没有回答「应用里到底显示的是不是 40%」**——它不是：那个 token 有两个画家，40% 落到屏幕上是 `1 - 0.6²` = **64%**（见第六节）。用户看到 64%，评价是「只有会话有背景啊，这怎么都黑了」。

然后 v2.27.1 修了画家数量，**顺手把 40 降到了 28**。28 在整窗复刻页上看着挺好：壁纸的雾感明明白白，列也还读得出来。真机上用户的原话是「侧边栏按钮没了」—— 深色主题的图标和文字是近白色（`#f9fafb`），壁纸左上角又正好是最亮的一块，28% 的纱压不住，白字直接洗白。**结构没问题，是数字掉到可读线下面了。**

所以 v2.27.2 把数字退回 40。变的不是数字，是数字终于等于它自己：单画家之后，40 就是 40，不是 64。同样的目标，纱少了 37%，图标看得见。

**教训写在踩坑 #19 里：标定好的数字，不要和结构修复塞进同一个版本。**两个一起上，出问题就分不清是谁干的——这次就是绕了一整轮才把「结构对了」和「数字太小」分开。

只改工作区的模式下这一项不进重混，左栏仍然是主题原色，下限用不上。

同理，底部状态栏 `[data-shell-bottom]` 横跨整个网格宽度，在只改工作区时会漏出左栏下方的壁纸，所以它单独被钉回主题底色；整窗模式下则不处理。

**顶部标题栏属于窗口外壳，不属于工作区，所以只改工作区时它保持布局原本的样子：整条铺侧栏色。** 布局把拖拽区画成框架上的 `::before`，铺的就是侧栏色；插件不动它，左栏和标题栏读起来是一整块连续表面，工作区从它下沿开始才是壁纸。

这里曾经用过渐变：到侧栏宽度为止是侧栏色，之后透明，让壁纸从工作区一直顶到窗口最上沿。它只在侧栏展开时成立——布局发布的是侧栏**轨道宽度** `--dsh-windows-sidebar-width`，侧栏一折叠这个值就变成 `0px`，渐变的色标全落在 0 上，整条通栏立刻退回成「全屏壁纸条」，也就是 v2.1.0 当初要修掉的那个现象。**收起侧栏就会复现，所以那个写法等于没修完。** 同一条规则还有第二个毛病：设置页是一整片铺满的底色，透明通栏压在它上面就是一条亮带。

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

磨砂玻璃按下表分档，因为这几类表面的性质不同：

| 档 | 谁 | 什么时候开 |
|---|---|---|
| 转写区 | 文件卡片、交付卡片、代码块、**内联 code 芯片**、**用户消息气泡** | **常开** |
| 输入框 | `[data-composer-card]`（模糊挂在 `::before` 上，见下）、底部状态栏、头部那排胶囊、底部那颗**「费用明细」胶囊**、**「回到最下面」圆钮** | 跟随「质感」开关 |
| 侧栏 | 新会话按钮、**历史记录背后那一块（随对话增长）**、左下角计费器 | 只在**整窗**作用域下开（列底色有 **40% 下限**，见第二节） |
| 右侧栏 | `[data-sidebar-right-panel]`（dockkit 的整列），下层 pane 停止画底色 | 跟随「质感」开关 |
| 菜单 | 所有走宿主菜单原语的弹出菜单（`/` 命令菜单、模型选择等） | 常开（`MENU_FILL` / `MENU_BLUR`，已固化） |
| 浮层 | 工作区悬停卡、短提示 tooltip | 常开（**深色**玻璃，字色写死成白，见下） |
| 压在正文上 | **转写区右侧标记的悬停预览卡** | 常开（主题色玻璃，**50% 填充下限**，见下） |
| 要读的整页 | **插件设置页** | 挂载时（82% / 26px，见第四节） |
| 宿主模态 | **任何 `role="dialog"` + `aria-modal="true"`**（DSH 设置、登录、版本提示、快捷键速查） | 模态打开时（58% / 42px，见第八节） |
| 兜底 | **任何探测器认为「不透明且够大」的表面** | 常开，可关（78% / 20px，见第七节） |

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

**三块侧栏 pane 共用一个填充：`paneFill()`。** 新会话按钮、历史块、计费器是同一列里同一张壁纸上的三块 pane，「多黑」必须是一个数。曾经是三个数：按钮和计费器走 `glassPane`（`--dshbg-raw-base` 22%），历史块却写的是 `--dshbg-raw-l1` **52%** —— 不同 token、两倍多的比例，于是块像一块黑板、紧挨着下面的计费器像一块亮玻璃，用户一眼就看出来了。

现在两边都读 `PANE_FILL` 这一个常量（`--dshbg-raw-base` 22%），冒烟测试里那条 `history block shares the cost meter fill` 会把两条规则里的 `background-color` 字符串直接比一遍 —— 这是「不许再分叉」的闸，光断言数值相等是不够的（两边一起改也相等，但那就不是 pane 配方了，所以还有一条 `sidebar panes stay on the pane fill` 钉住那个值本身）。

22% 是 pane 的比例，不是口味：pane 后面只有壁纸。**压在内容上的控件另有三档** —— 内联芯片 45%、悬浮圆钮 58%、深色玻璃浮层 50%/58% 下限。

块的描边仍然是 **inset 阴影而不是 `border`**：宿主没给这些侧栏盒子写 `box-sizing: border-box`（它的行是 content-box），真加 1px 边框会把块撑宽 2px，右边缘就跟新会话按钮对不上了。inset 环画在盒子内部，不花布局。

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

填充和模糊这两个数字由菜单、输入框、右侧栏、悬停预览卡**共用**（`MENU_FILL` / `MENU_BLUR`）。它们是同一种材料，必须一起动；只把菜单调好看、让输入框停在另一个不透明度上，正是「一眼看出是拼起来的」那种效果。

**填充量到多少合适？** 下面这张表是在**模糊还死着**的前提下量的（壁纸亮部 + 13.5px 正文）——所以它量的是「没有模糊时，多厚的色板才能压住字」，不是玻璃的参数：

| 填充 | 合成底色 | 正文对比度 | 面板亮度 / 起伏 |
|---|---|---|---|
| 100%（不透明） | `#232324` | 8.5:1 | 35 / **0.00** |
| 76%（v2.23.0 的默认） | `#303c45` | **6.1:1** | 63 / 12.5 |
| **30%（现在固化的值）** | — | — | 靠 13px 模糊兜住 |
| 62% | `#374b58` | 7.1:1 | 79 / 20.0 |
| 45%（宿主原值） | `#4f6c80` | 3.0:1 | 113 / 28.4 |

62% 的对比度反而比 76% 高（底色更亮、白字更亮）——**只看对比度会选错档**。当时的判据是「背景大字能不能被抹掉」：壁纸上那行 60px 的时钟，40px 模糊下抹不掉，62% 能看见鬼影。**但那个「抹不掉」本身就是模糊失效的症状**——模糊真工作之后，40px 连 60px 的字都能抹平。这张表只能当「最坏情况的下限」看。

> **这两个数字已经固化了：`MENU_FILL = 30`、`MENU_BLUR = 13`。**
>
> 它们曾经是设置页上并排的两条滑块（`settings.menuFill` / `menuBlur`），因为这对参数只有眼睛能判断。用户在自己那张照片上试出来的结论是 30% / 13px —— 比出厂的 76% / 40px 透得多，比上面那张表推出来的任何一档都透。原因就是表的前提（模糊失效）已经不成立了。
>
> 滑块、四条 `TEXT` 文案、`readSettings` 里的两行 clamp 全部删掉了。现在是模块级常量，不是 setting：**一处材料一个数字**，谁读它都不会分叉。老用户 localStorage 里残留的 `menuFill` / `menuBlur` 会被直接忽略。
>
> 冒烟测试跟着翻转成反向断言：`menu fill is baked, not a setting` / `menu blur is baked, not a setting` / `the whole material shares one fill` / `temporary sliders are gone`。前两条的写法是「传一个残留的旧设置进去，样式表必须还是常量值」——它们才是拆滑块之后唯一会提醒你「别再改回写死字面量」的闸。


**转写区常开**：它们是内容不是外壳，压在工作区的壁纸上面。一块实色卡片铺在壁纸中间，读起来就是画面上打了个洞。所以「质感」切回实心只说明输入框要实心，不该连带把整篇对话里的代码块和文件卡都拉回实色。

**转写区右侧那排标记的悬停预览卡，走的是「压在正文上」那一档，不是 pane。**

鼠标移到转写区右边那排小标记上，会弹出「这一问 + 三行回答」的预览卡（`xpvNua_preview`，`width: min(300px, 100cqw - 120px)`，一行 13px 粗体问句 + 最多三行 12px 回答）。它画的是 `--dsw-alias-bg-layer-1`，而这个 token **在**重混列表里。

这段历史值得记，因为它翻转过两次：

1. 最早没有专门规则 → 卡片跟着面板那一档掉到 ~28% → 背后的正文原样穿过来，预览看不清、被盖住的那段正文也看不清。**这时「透明度不是风格而是 bug」是对的。**
2. v2.16 的修法是把捕获的原始 layer 值钉回去，也就是**完全不透明**。读是能读了，但整窗就剩这一块实心黑方块——用户截图一眼挑出来（实测卡片内部像素 `(35,35,36)`，纯 `#232324`）。
3. 现在是玻璃：共享 `MENU_FILL` / `MENU_BLUR`，但**填充有 50% 硬下限**。它和悬停卡是同一类表面（都是压在内容上的浮层），所以用同一个下限。固化后实际生效的是下限，不是共享值。

能这么做的前提是**它没有带 `backdrop-filter` 的祖先**。卡片是 `_scroller` 的**兄弟**不是子节点（`<nav> > [scroller][marks] + [preview]`），`_slot` 的 `container-type` 和 `_frame` 的 `contain: layout` 只建包含块、不建 backdrop root。**哪天这里的模糊又「没生效」，先查这条祖先链**（见第十二节踩坑 #10）。

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
| 悬停预览卡 | `[class*="_preview"]:has([class*="_previewResponse"])` | 好几个模块都用 `_preview` 命名，用「里面有没有 response 那行」收口。玻璃能不能生效取决于祖先链——它是 `_scroller` 的兄弟，见上 |
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

## 四、设置页为什么是磨砂的

壁纸压在标题后面就没法读了。但「哪一栏是设置页」不能靠猜 DOM。

做法是让**组件自己声明**：配置页挂载时给 `<html>` 打 `data-dshbg-config`，卸载时移除。样式表据此把壁纸覆盖的那部分铺成一层重霜——只改工作区时铺中右两栏，整窗模式铺整个框架（否则左栏会变成设置页旁边的一条透光带）。

只认 `view === 'page'`，因为同一个组件在插件列表里也会以 summary 形式渲染一次——那种情况下不应该把整页刷一遍。

霜层铺在**栏**上而不是内容块上：页面容器是 `align-items:center` 的 flex column，内容块被限制在 `max-width:960px`，只铺内容块会在两侧各留一条透壁纸的亮缝，看起来像渲染 bug。

**它曾经是完全不透明的，那是错的。** 当时的推理是可读性：一页 12px 控件压在照片上比压在纯色上难读，所以干脆做实。但「面板不透明度」拉到 0 之后，整窗唯一一张实心黑板就是这一页——用户截图一眼挑出来，直接点名。

「不透明」和「可读」不是同一个要求。重度磨砂（`SETTINGS_FILL` 82% / `SETTINGS_BLUR` 26px）保住壁纸的形状——页面还是一块玻璃，不是另一扇窗——同时把背后磨平到够读。这两个数刻意不等于 `MENU_FILL`：菜单是扫一眼就走的，设置页是要逐行读的。

代价是标签色必须还原。自动配色是照着壁纸选的，压在磨砂层上可能和背后的色调撞在一起，所以 `LABEL_TOKENS` 全部还原成主题原值，并且要同时压过 `fontCss`（同一元素，两个 `!important` 靠属性选择器的特异性分胜负）。

## 五、捕获挂错了元素：有一整层变量从来没生效过

这一节是 v2.27.0 挖出来的，也是这个插件最贵的一个 bug —— 因为它**安静**：不报错、不闪烁、看上去「也算玻璃」，只是发白、发亮、没有底。

### 症状是三个，根因是一个

用户连着报了三件事，看起来互不相干：

- 「模糊细节又没了」—— 设置弹窗背后，正文原样穿过来
- 「左边这个地方的灰底还没了」—— 侧栏变成纯壁纸，导航项和会话列表浮在照片上
- 「玻璃质感可以再加一加」—— 面板像是水洗过，颜色淡得没有存在感

三个都是同一句话：**面板根本没有底色，你看到的「玻璃」只有模糊。**

### 怎么发现的：不要靠看，去读计算值

`diag/eval.cjs` 里一句 `getComputedStyle(panel).backgroundColor` 就够了：

```
宿主自己的 CSS 说：  background: var(--dsw-alias-bg-layer-2)   /* #2c2c2e */
浏览器算出来的是：  rgba(0, 0, 0, 0)
```

宿主的规则没写错，是**变量本身是空的**。继续往下问一层：

```
getComputedStyle(panel).getPropertyValue('--dshbg-raw-l2')      ->  ""
```

捕获出来的原值就是空的。到这一步就没有别的可能了。

### 根因：主题不是声明在 `:root` 上的

DSH 的调色板长这样：

```css
body { --dsw-alias-bg-layer-2: …; }                       /* 浅色 */
body[data-ds-dark-theme] { --dsw-alias-bg-layer-2: …; }   /* 深色 */
```

**在 `body` 上，不是 `:root` 上。** 自定义属性只向下继承，所以在 `<html>` 上 `var(--dsw-alias-bg-layer-2)` 取到的是 guaranteed-invalid。整条链就这么断的：

```
--dshbg-raw-l2: var(--dsw-alias-bg-layer-2)        ← 在 <html> 上：空
--dsw-alias-bg-layer-2: color-mix(in srgb, var(--dshbg-raw-l2) 16%, transparent)
                                                   ← 替换后变成 color-mix(in srgb, 16%, transparent)
                                                   ← 计算值时刻非法 → 这个属性也变成 invalid
background: var(--dsw-alias-bg-layer-2)            ← 引用 invalid 的自定义属性 → 退回 transparent
```

**每一个面板都是全透明的。** 之前所有「surface + lift%」的说法一次都没落地过。

### 为什么一年没被发现

因为它失败得太像「设计」了。全透明 + `backdrop-filter` 模糊，看起来确实像一块玻璃——只是发白发亮、没有分量。而**所有「黑框」恰恰是没被重混到的表面**，它们的颜色照旧，于是「黑框」和「太透明」这两个相反的症状同时存在，看起来像两个问题。修黑框的每一次努力方向都是对的，只是地基是空的。

同一件事也解释了为什么每次调填充数字，观感变化都远小于预期：那些数字没进过屏幕。

### 修法：捕获下移一层，重混再下移一层

```css
html[data-dshbg-on] body { /* 捕获 */ }
html[data-dshbg-on] body > * { /* 重混 */ }
```

- **捕获必须在 `body`** —— 那是主题声明 token 的地方。
- **重混必须在下一层** —— 同一元素上捕获会读到已经被重混过的值（`--dshbg-raw-x: var(--dsw-alias-x)` 是计算值时刻的替换，读的是声明它的元素上的当前值），整条配方塌掉。这是硬约束，不是风格。
- **为什么是 `body > *` 而不是 `#root`** —— `#root` 不是整个文档，所有 portal（计费器弹窗、悬停卡、团队面板、任何第三方浮层）都是它在 `body` 下的**兄弟**。`body > *` 一次覆盖 `#root` 和所有 portal。
- **为什么停在 `body` 不再往下** —— `body` 自己保留主题原值，捕获才是捕获。`body` 自己的底色由壁纸层强制透明，文字颜色由 `fontCss` 单独管，不需要重混。

判据很硬：`getComputedStyle(panel).backgroundColor` 必须是一个真的半透明色（`color(srgb … / 0.58)`），不是 `rgba(0, 0, 0, 0)`。

### 修好之后，所有的数字都得重新看一遍

以前每个面板都是 0%，所以「看起来」的观感 = 纯模糊。现在 `surface + lift` 真的生效了，同样的数字会比以前**实**得多。两处因此必须单独处理：

- **侧栏需要下限**（`SIDEBAR_FLOOR`，见第二节）—— 它的 `lift` 是 0，`surface: 0` 时真的是 0，而现在 0 是「真的什么都没有」。
- **模态需要自己的刻度**（见第八节）—— 它的 token 只给 16%，离「能读」很远。

## 六、一个 token，两个画家

v2.27.1 的重点。用户的原话只有一句：

> 只有会话有背景啊，这怎么都黑了

截图里整窗都暗下去，只有中间那一栏还能看见壁纸的颜色。

### 症状：会话栏是亮的，其余全是黑的

把截图按行扫一遍，边界非常硬：x≈400 左边是 `(41, 58, 76)`，右边是 `(88, 148, 205)`。同一条水平线上，左半窗比右半窗暗一倍还多，而且不是渐变，是一条竖线。

先把「壁纸本来就是这样」排除掉：`background-size: cover` + `position: center`，壁纸在窗口上是连续的一张图，而标题栏那一条（横跨整个宽度）是亮的 —— 说明壁纸在左上角也是亮的。所以变暗不是壁纸的错，是有人在上面盖了东西。

### 根因：宿主把同一个 token 画了两次

```
css-AppFrame.css    .BynINW_sidebarCol { background: var(--dsw-specific-sidebar-fill) }
css-SidebarRoot.css ._2H3hWW_root      { background: var(--dsw-specific-sidebar-fill) }
```

`sidebarCol` 是栅格里的那一格，`_root` 是 `SidebarRoot` 渲染出来、正好填满这一格的那个 div。**两个都画，同一个 token。**

中间那一栏有一模一样的形状（`centerCol` 与 `ConversationRoot` 都画 `--dsw-alias-bg-base`），但**那一半暂时没修**，理由在下面「为什么中间那栏被撤下来了」。

**在宿主自己的设计里这是完全正确的写法。** 两层的颜色都是同一个不透明色：`#1b1b1c` 叠在 `#1b1b1c` 上还是 `#1b1b1c`。栅格负责定位、根负责铺底，颜色相同所以谁画都一样，多画一层零成本。宿主这么写了几百个组件，没人有理由发现它。

我们把这个 token 换成半透明的那一刻，它就变成了 `1 - (1 - a)²`：声明的 40% 落到屏幕上是 **64%**。而中间那一栏的 `bg-base` 在 `surface: 0` 时是 0%，两层都是 0 所以还是 0 —— 于是「会话栏透亮、别处发黑」，正是用户描述的那样。

### 怎么量出来的：从像素反解 alpha

不用猜，拿数反解。设壁纸（含 28% 压暗）在侧栏位置是 `W`，纱是 `#1b1b1c`：

```
实测 (41, 58, 76) = a·(27, 27, 28) + (1-a)·W
```

一个方程两个未知数，但 `W` 可以从会话栏那一侧借：同一行、同一张 `cover` 的图，右边界处是 `(88, 148, 205)`，减去横向梯度外推，侧栏位置的壁纸大约是 `(66, 113, 161)`。代回去三个通道分别解出 `a = 0.74 / 0.65 / 0.62`。

**单层 40% 无论如何给不出 0.65。** 双层 `1 - 0.6² = 0.64` 正好落在这个区间里 —— 这就是判据。

然后把它变成可复现的实验：`diag/window-replica.html` 用宿主自己的 CSS（`theme-dark.css` / `css-AppFrame.css` / `css-SidebarRoot.css`）、用户自己那张壁纸、按用户自己那套设置导出的样式表，把整个窗口画出来。壁纸是从 `IndexedDB/dsh-app_app_0.indexeddb.blob/` 里按 `data:image` 前缀捞回来的 —— 那是插件的图片库，插件自己存的是 data URL，不是文件。

```
?v=old  侧栏 (46, 62, 77)   会话 (49, 72, 124)      ← 64%，双层
?v=now  侧栏 (60, 86, 110)  会话 (49, 72, 124)      ← 40%，单层
```

会话栏逐像素不变（它本来就没错），侧栏亮了约三分之一。

### 修法：让列不画，让根来画

```css
html[data-dshbg-on][data-windows-titlebar]
  #root div:has(> [data-shell-overlay]) > div:nth-of-type(1):has([class*="_root"]) {
    background: transparent !important;
  }
```

**该退场的是外壳，不是根。** 栅格格的职责是「把东西摆在哪儿」，根才是「东西底下的那层表面」。反过来杀掉根需要它的构建哈希类名（`_2H3hWW_root` 每次打包都变），而且 `_root` 这个局部名在 bundle 里被 `SettingsRoot` / `SidebarRoot` / `ConversationRoot` 共用，`[class$="_root"]` 会误伤一片。列则是结构可寻址的 —— 和 `chatSurfaceCss`、`configPageCss` 用的是同一套 `div:nth-of-type` 锚点。

### `:has()` 那个守卫是安全联锁，不是装饰

`:has([class*="_root"])` 的意思是「这一格里确实有一个侧栏根」。没有它就等于假设「列永远有根接着」—— 而这个假设一旦错，代价不是「还是有点黑」，是**整列没有任何画家**：一块透明的侧栏，上面浮着一排看不见的白字和白图标。v2.27.1 发出去之后用户的「侧边栏按钮没了」「侧边栏打不开」正是在描述这个画面（虽然那一版真正的原因是数字，见第二节）。

有守卫，假设错了就退回旧的 64% —— 暗，但能用。**故障要往「难看」的方向倒，不能往「没有」的方向倒。**

守卫匹配的是根的**局部名**（`_root`），构建哈希在它前面、每次打包都变，所以只能用 `*=` 不能用 `$=`（`_2H3hWW_root _2H3hWW_collapsed` 这种带第二个类的写法会让 `$=` 匹配不上）。

### 为什么侧栏那一条要限定 Windows

因为 macOS 上情况是反的：

```css
[data-platform=darwin] ._2H3hWW_root { background: 0 0 }
[data-platform=darwin] .BynINW_sidebarCol { background: linear-gradient(...), color-mix(...) }
```

宿主在 darwin 上把填充**从根搬到了列**（还加了一层渐变）。那里列是唯一的画家，把它打透等于把侧栏删掉。`[data-windows-titlebar]` 恰好就是「两层都在画」的那个条件，所以侧栏这条必须挂在它下面。

### 为什么中间那栏被撤下来了

`centerCol` + `ConversationRoot` 是同一个形状，v2.27.1 一起修了。2.27.2 把那一半撤掉，只有一个理由：**它在用户的设置下（`chatSurface: 0`）是零变化，因此无法验证。**

0% 的两层叠起来还是 0%，改不改一模一样。一条改不出任何像素差异的规则，我没有任何办法证明它在真机上是对的 —— 而它偏偏和一条真的会改变画面的规则塞在同一个版本里。用户回头报「对话框模糊没了」「右侧历史记录模糊没了」时，我连「是不是这两条干的」都回答不了，只能靠推理排除（结论：不是，因为中间那栏的改动在该设置下是 no-op；右侧栏在 `div:nth-of-type(3)`，压根没碰）。

**放回去的条件**：整窗复刻页里把 `chatSurface` 开到一个非零值，截图对比改动前后。能看见差异了，才叫能验证。

在那之前，`chatSurface` 的已知偏差留在第十四节：滑杆离开 0 之后，实际落地是 `1-(1-a)²`，比滑杆给的多。

### 自查清单

改任何跟表面有关的规则之前，先回答这三个问题：

1. **这个 token 有几个元素在画？** 宿主经常让外壳和根各画一次，因为它们颜色相同。半透明之后不是了。
2. **我改的是「谁画」，还是「画多少」？** 这一节修的是「谁画」。数字（`SIDEBAR_FLOOR`、`MODAL_FLOOR`、`lift`）只有在「谁画」唯一之后才有意义 —— 否则调数字是在补偿一个结构错误，改一处、坏三处。
3. **如果我的假设错了，故障往哪边倒？** 让列不画，就要保证根真的在画 —— 用 `:has()` 把它写成条件，别写成信仰。倒向「难看」可以接受，倒向「没有」不行。


## 七、黑框为什么长出来，以及怎么一次全兜住

这一节是 v2.25.0 的重点：用户的原话是「尝试找出所有可能的黑框，比如设置，或者你直接加全局变量」。

### 根因：`#root` 不是整个文档

token 重混（把 `--dsw-alias-*` 换成 `color-mix` 半透明）一直挂在

```css
#root div:has(> [data-shell-overlay])
```

那个 frame 上。但计费器弹窗、悬停卡、团队面板、任何第三方浮层，都是 `#root` 在 `<body>` 下的**兄弟节点**——React 的 portal 都挂在那儿。挂在 frame 上，这些浮层一个都读不到重混值，于是继续画主题原来的不透明色。面板不透明度压到 0 的时候，它们就是整窗唯一剩下的几块实心黑板。

现在**捕获在 `<body>`、重混在 `body > *`**（v2.26.0 时这里是「捕获在 `<html>`」，那一版是错的 —— 见第五节）。这个分离是承重的：

- `--dshbg-raw-x: var(--dsw-alias-x)` 是**计算值时刻**的替换，读的是**声明它的那个元素**上的 `--dsw-alias-x`。捕获和重混放在同一元素上，捕获就会读到已经被重混过的值，整条配方塌成透明。
- 重混放 `body > *` 而不是 frame，是因为浮层全在 frame 外面；放在 `body` 本身又会撞上第一条（`body` 正是捕获层）。

作用域没变：work-area 模式下 `--dsw-specific-sidebar-fill` 依然**不写进**重混，侧栏保持主题原样。靠「不发射」实现，不需要额外的还原规则。

### 剩下的：结构上够不到

改完 `<body>` 之后还有黑框，但那些不是漏配，是**结构上够不到**：

| 来源 | 例子 | 为什么变量改不到 |
|---|---|---|
| 插件写死颜色 | `dsh-free-search` 的 `background:#1c1c1e` | 不是 token，重混无从下手 |
| 插件把 alpha 重新钉死 | `dsh-cost-meter`：`rgb(from X r g b / 1)`、`max(alpha, .9)` | 透明度过不了这一层 |
| 宿主用了不在列表里的变量 | `--dsw-hovercard-bg`、`--dsw-alias-tooltip-bg`、`--dsw-menu-surface-fill` | 不在 `SURFACE_TOKENS` 里 |
| 伪元素 | `dialog::backdrop` | 不是元素，JS 也够不到 |

一个个去追不会收敛——那份名单等于「用户下一个装的插件」。所以规则改成一劳永逸地陈述一次：

> **任何计算出来不透明、面积又够大的元素，都按它自己的原色降 alpha 加磨砂。**

原色由探测器抄进元素的 `--dshbg-auto-fill`，所以暖色的面板还是暖色，只有 alpha 会动。填充 78% / 模糊 20px，比菜单保守：菜单是代码认识的表面，探测器找到的是代码从没见过的，可能满是 13px 正文。

### 探测器怎么工作

`installAutoGlass()`：`MutationObserver`（只监听 `childList`）+ 去抖 220ms → 扫 `body` 下所有元素 → 打 `data-dshbg-auto` → 一条 CSS 规则接收。

几处刻意的取舍：

- **变量缺失时落到 `transparent`，不是黑色。** `color-mix(in srgb, var(--没定义) 78%, transparent)` 在计算值时刻失效，`background-color` 退回初始值 `transparent`。失败模式是「变没」而不是「变黑」——这是把颜色放进变量、而不是让 JS 内联写死的全部理由。
- **原色另存一份在 Map 里。** 框架整体重写 `style` 会抹掉内联自定义属性、留下属性标记；那时再读计算值毫无意义（我们自己的规则已经生效，报的就是 `transparent`），只有存下来的原色可信。
- **扫描分批。** 长会话几千个节点，一次全扫会卡一帧。游标轮转，每个节点都会被看到，只是不挤在同一个 tick。
- **不监听属性。** 打标记本身就会改 `style` 和属性，监听属性会自激。
- **work-area 作用域以 `#root` 划界。** 里面归主题（侧栏是**故意**留原样的），外面（浮层）才归探测器。不这么划，作用域开关等于被悄悄废掉。
- **`dialog::backdrop` 单独一条 CSS。** 它不是元素，探测器够不到。弹窗本体是玻璃、外面套一圈死黑，看起来还是黑框。
- **有开关**（`autoGlass`，默认开）。误伤就关掉，其它玻璃效果不受影响。

### 还有一条自我约束

探测器读的是**我们自己规则生效之后**的计算值。所以已经被处理过的表面（`#root`、`body`、所有跟着 token 走的半透明面板）读出来 alpha 就不到 1，直接放过。这套东西不会跟已有的配方打架——它只看「我们没管住的那部分」。

### 但它只管「不透明」，管不了「透明过头」

探测器找的是**黑框**：算出来 alpha ≈ 1、面积够大的表面。反过来那种坏法它一个都抓不到——一个**设计成不透明的模态**，被重混推到 16%，于是又透又没磨。那是下一个坑，也是下一节。

## 八、模态不是面板：透明过头，和遮罩那条边

前五节的前提是「一块表面 = 隔着 N% 颜色看壁纸」。对**模态**这个前提是错的：模态存在的意义是**被读**，它背后是正文。忽略这一点会同时长出两个毛病，而且是一张截图里同时出现的。

### 一、面板被重混推得过于透明，而且它本来就没有模糊

DSH 自带的设置弹窗（`ui-settings-general`）挂在 **`#root` 外面**——它得这么挂，否则文档序更靠后的 chrome 行声明的拖拽区会吞掉它的控件。面板本身是：

```css
.panel { background: var(--dsw-alias-bg-layer-2); /* 深色主题 = #2c2c2e */ }
```

`--dsw-alias-bg-layer-2` **在** `SURFACE_TOKENS` 里，所以重混把它压到 `surface + 16` —— `surface: 0` 时只剩 **16%**。而它自己不带 `backdrop-filter`（本来就不需要，它是实心的），背后的遮罩也帮不上忙：

```css
.mask { background: var(--dsw-alias-bg-mask-1); backdrop-filter: var(--dsw-mask-blur); }
/* 而 --dsw-mask-blur 在亮/暗两套主题里都是 none —— 遮罩只压暗，完全不磨 */
```

16% 的面板 + 只压暗没磨的正文 = 正文原样穿过弹窗，两段字叠在一起。

**所以模态单独一套配方，而且必须同时有填充和模糊。** 真正让 13px 字读得出来的是模糊，不是填充：`diag/settings-modal.html` 上量过，面板内部一块没有文字的区域的纹理起伏（stddev）从 **2.27 降到 0.59**，压平了约四倍。填充只负责把剩下的那点亮度差压住。

⚠️ **v2.26.0 只修好了一半，而且当时不知道。** 那一版给模态加了填充和模糊，但填充读的是 `--dshbg-raw-l2`，而那一层捕获当时挂在 `<html>` 上（见第五节）——算出来是空的。所以模态实际上一直是「只有模糊、没有底」。这也是为什么下一版用户还在说「玻璃质感不够」：不是数字调小了，是数字没进屏幕。

**填充现在跟着滑杆走，带下限和上限。**

```js
modalFill = clamp(surface + MODAL_LIFT, MODAL_FLOOR, MODAL_CEILING)  // 58 / 16 / 96
```

一个固定数字在两头都是错的：`surface: 100` 时它会在一个不透明的窗口里挖出一个洞，`surface: 0` 时它又拒绝变得更玻璃。跟着滑杆走、再用上下限夹住，两个毛病一起没有。下限存在的理由不是好看，是**读得出来**——越过它，弹窗就不成其为弹窗了。模糊 42px，比面板级的一档重得多，因为模态背后是正文。

### 二、面板里的控件是另一半，而且要反过来修

面板变玻璃之后，弹窗里最后几个实心块就显出来了：`通用设置` 那个选中行、右边一排 `工作区内修改` / `中文` / `标准` / `下次有新消息时` / `14px` / `深色`。它们读的是两个**不透明中性色**：

| token | 谁在用 | 深色主题值 |
|---|---|---|
| `--dsw-alias-bg-module-platform` | `_selector`、`_stepper`、选中的 `_themeCube` | `#353638` |
| `--dsw-specific-sidebar-nav-item-active` | 选中的 `_navCell` | `#43454a` |

**不能简单把它们换成同色半透明。** 宿主是**故意**把它们选得比面板亮一点（那是「凸起」的视觉语言）。两层都半透明之后，一个「更亮但不透明」的中性色在亮壁纸上反而变成画面里最暗的东西——提高 alpha 就退回实心，降低 alpha 就消失，**没有一个 alpha 能修正这个极性**。

所以面板内部换成**标签色的纱**：

```css
--dsw-alias-bg-module-platform: color-mix(in srgb, var(--dshbg-raw-label-0) 24%, transparent);
--dsw-specific-sidebar-nav-item-active: color-mix(in srgb, var(--dshbg-raw-label-0) 32%, transparent);
```

`--dsw-alias-label-primary` 自己会跟着主题翻极性（深色主题 `#f9fafb`、浅色主题 `#0f1115`），所以同一行 CSS 在两套主题里自动是「白纱 / 黑纱」。这也正是宿主自己处理交互态的办法——`--dsw-alias-interactive-bg-hover` 就是 `rgba(255,255,255,.08)`，`-active` 是 `.14`——控件留在设计语言里，不另起一套。

**override 声明在面板上**，于是它顺着继承往下走、到弹窗为止：应用自己的左栏选中行保持不透明，读同一个 token 的表格表头、代码块、徽章一个都不受影响。（这三处如果全局重混，粘性表头会透出下面的行，是真正的事故。）

**为什么不用类名当钩子。** `.wCInkW_panel` 是构建期哈希，每次打包都换（v2.24.0 就是死在这一点上）。用的是组件自己 JSX 里的语义属性：

```jsx
<div className={css.panel} role="dialog" aria-modal="true" data-shortcut-modal="settings">
```

`role` 和 `aria-modal` 是无障碍语义，改样式不会动它们。顺带一个好处：这条规则一次覆盖**所有**宿主模态——登录、版本提示、快捷键速查——不是只修截图里那一个。

**为什么这条规则要包在 `:where()` 里。** `:where()` 的特异性是零，于是它的实际特异性只有 `html[data-dshbg-on] body` —— 任何 `.class` 规则都能压过它。`costMeterCss` 那两条 93% 的弹窗就是靠这一点保住自己的数字的。**兜底规则必须是输的那一方，不能是赢的那一方。**

### 三、遮罩故意不画标题栏，于是在壁纸上画出一条硬边

遮罩的定位是：

```css
.mask { inset: var(--dsh-frame-chrome-top, 0px) 0 0; }
```

Windows 下 `--dsh-frame-chrome-top` 正好等于 `--dsh-windows-titlebar-height`。宿主是**故意**这么写的，文档里也写着「让模态遮罩不绘制 Windows 顶栏区域」——为了不压暗原生的最小化/最大化/关闭。铺平色的时候谁也看不出来；**压上壁纸之后，那就是一条横穿窗口的硬边**，位置正好在那一排按钮下面。

标题栏那条是 `frame::before`（`position: absolute; inset: 0 0 auto; height: var(--dsh-windows-titlebar-height)`，同时也是拖拽区）。所以缺的那一条是个**已知的、可寻址的盒子**：模态打开期间，给它补上同一层压暗。

补的必须是 `--dsw-alias-bg-mask-1` 这个变量，不是写死的黑色——遮罩换主题时两边要一起动。用 `background-image: linear-gradient(同一个颜色 ×2)` 而不是 `background-color`：这样它是**叠在**顶栏原有底色之上的一层，整窗作用域（顶栏透明）和工作区作用域（顶栏是侧栏色）两种情况下都对，不用分叉。

实测（`diag/busy-before.png` / `busy-after.png`，右侧干净壁纸处，y=32→33）：

| | y=32 | y=33 | 落差 |
|---|---|---|---|
| 改前 | `2a344b` | `151a25` | **(−21, −26, −38)** |
| 改后 | `151a25` | `151a25` | **(0, 0, 0)** |

**为什么不干脆把遮罩改成 `inset: 0`。** 遮罩是个真元素，带 `onClick` 关闭弹窗，而且它会盖住拖拽区——只要开着一个弹窗，窗口就没法靠标题栏拖了。补一层背景是纯视觉的，代价为零。

### 四、为什么没有顺手把遮罩也磨了

第一版试过给遮罩加 `blur(28px)`。`diag/settings-modal.html` 直接证明那是错的：全视口模糊会把**整个窗口**——侧栏、正文、所有东西——一起糊成一片。那是在损失信息，不是在修 bug。**磨砂属于「必须能读」的那个面板，不属于背景。** 面板外面那块在改前改后是逐像素相同的（mean 25.7/30.2/41.0，stddev 4.63，两边一致），这就是「只修了该修的」的判据。

## 九、右上角那三个按钮是怎么改的

最小化 / 最大化 / 关闭**不是 DOM 按钮**。Electron 用原生 title-bar overlay 画它们，overlay 自己带不透明底色，所以任何针对框架的 CSS 都碰不到——这就是它们一直是块实色、周围全变玻璃的原因。

但 preload 留了一个口子。它往 `<body>` 里塞了一个隐藏探针：

```html
<span style="...;background-color:var(--dsw-specific-sidebar-fill);
             color:var(--dsw-alias-label-primary)">
```

然后读这个探针的**计算值**，通过 `dsh-desktop:windows-appearance` 发给主进程，主进程转手调用 `setTitleBarOverlay`。它还用 MutationObserver 盯着 `<head>` 的 childList / characterData——所以**插入这张样式表这个动作本身**就会触发重新取值。不需要 IPC 权限，插件关掉后主题色自动回来。

真正的 bug 在这里：探针是 `<body>` 的子节点，它在 `<body>` 上解析内联的 `var()`，**比 token 被重混的 frame 高一层**。所以它一直读到未经重混的、不透明的侧栏色。

修法只针对探针本身，不去 `<body>` 上重写 token——那样会把左栏一起拖下水，还会让同一元素上的 `--dshbg-raw-*` 捕获变成自我引用。符号色按壁纸实测明暗取，不跟用户的字体选择走：这是为了在图上看得见，不是阅读偏好。

## 十、字体颜色

| 模式 | 行为 |
|---|---|
| 跟随主题 | 什么都不改（默认） |
| 自动 | 把背景画到 16×9 离屏 canvas 上抽样 Rec.601 亮度，穿过「压暗」和「面板不透明度」两次折算，超过 140 用深色字，否则浅色字 |
| 浅色 / 深色 | 固定色板 |
| 自定义 | 指定主色，其余层级由 `color-mix` 推导 |

自动模式是**纯函数**：同一个亮度永远得到同一个色调，不参考上一次的结果。这不是风格问题——早期版本用了双阈值迟滞并且方向写反，导致色调反复翻转、每次翻转触发重绘、重绘又触发测量，事件循环被占满、进程假死。

## 十一、代码结构

```
client.js
├─ 常量        DEFAULTS / GRADIENTS / SWATCHES / FONT_PALETTES
│              MENU_FILL / MENU_BLUR（玻璃材料，固化值）
│              PANE_FILL / SETTINGS_FILL / SETTINGS_BLUR / AUTO_FILL / AUTO_BLUR
│              SIDEBAR_FLOOR（侧栏列底色的下限，40）
│              MODAL_LIFT / MODAL_FLOOR / MODAL_CEILING / MODAL_BLUR / MODAL_CONTROL_FILL / MODAL_NAV_FILL
├─ 文案        TEXT.zh / TEXT.en
├─ 工具        clamp / currentLang / colourAlpha
├─ 持久化      readSettings / writeSettings（localStorage）
├─ 图片库      openDb / dbRun / ingestFile（IndexedDB + 降采样到 2560px）
├─ 亮度        lumaOfCss / lumaOfImage / measureLuma / toneOf
├─ 状态        state + subscribe / commit / patchSettings
├─ 选择器      frameSelector / workAreaColumns / bottomRowSelector
├─ 样式        wallpaper / token / columnPaint / chatSurface / composer / glass / chrome / caption / bottomRow / font / configPage / modal / modalFill / costMeter / autoGlass
├─ 安装        installStyles（apply 内注入 <style>，ctx.effect 托管清理）
├─ 探测器      installAutoGlass（MutationObserver + 分批扫描 + 打标记，兜住 token 够不到的表面）
├─ 组件        Switch / Segmented / Slider
└─ 页面        ConfigPage（注册到 plugins.bundle.config）
```

## 十二、踩过的坑（改动前务必看）

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

**12. `#root` 不是整个文档，所以「重混挂在 frame 上」永远兜不住浮层。**

`frameSelector()` 拿到的是 `#root div:has(> [data-shell-overlay])`，看着像「整个应用」。但 React 的 portal 全部挂在 `<body>` 下，是 `#root` 的**兄弟**：计费器弹窗、悬停卡、团队面板、任何第三方浮层。挂在 frame 上的 token 重混，它们一个都继承不到。

这个 bug 的隐蔽之处在于它**只在面板不透明度被压得很低时才暴露**。表面不透明度 55% 的时候，浮层画主题原色看起来「只是稍微实一点」；拉到 0 的时候，它们就是整窗唯一剩下的实心黑板。

**判据**：任何「作用在整个应用上」的 CSS，先问一句「这东西到底覆盖了几个节点」——`document.querySelector(sel)` 能命中不代表 `sel` 就是文档根。挂变量的位置和读变量的位置之间，每多一层兄弟关系就是一个漏点。

**13. 捕获和重混不能放在同一个元素上。**

`--dshbg-raw-x: var(--dsw-alias-x)` 和 `--dsw-alias-x: color-mix(... var(--dshbg-raw-x) ...)` 如果都写在同一个选择器里，第一条读到的是**已经被第二条改写过的**值（自定义属性在计算值时刻替换，读的是声明元素上的当前值），整条配方塌成 `transparent`。

所以现在是 `<body>` 捕获、`body > *` 重混。这不是风格，是硬约束——顺手把「浮层继承不到」那个 bug 也一起修了，因为 `body` 的子节点包含了 `#root` 和所有 portal。

**14. 「捕获在 `<html>`」是错的，因为主题声明在 `body` 上。**

这是 v2.27.0 之前一直存在、而且从没被发现的 bug。DSH 的调色板是 `body { --dsw-alias-* }` / `body[data-ds-dark-theme] { --dsw-alias-* }`，**不是 `:root`**。自定义属性只向下继承，所以在 `<html>` 上捕获到的每一个 token 都是 guaranteed-invalid，`color-mix(in srgb, <空> 16%, transparent)` 在计算值时刻非法，重混出来的属性也非法，`background: var(...)` 最终退回 `transparent`。

**所有面板其实一直全透明**，看起来像玻璃全靠 `backdrop-filter`。详见第五节。

**判据**：任何 `--x: var(--y)` 的捕获，先确认 `--y` 在**那个元素上**真的有值。用 `diag/eval.cjs` 读 `getComputedStyle(el).getPropertyValue('--x')`，返回空字符串就是断了——不要靠看截图猜。

**15. 半透明层不能靠「更亮的中性色」表达凸起。**

`--dsw-alias-bg-module-platform`（`#353638`）比面板（`#2c2c2e`）亮，这是宿主表达「控件凸起」的方式。两层都半透明之后，这个「更亮但不透明」的中性色在亮壁纸上反而成了画面里最暗的东西——提高 alpha 退回实心，降低 alpha 消失，**没有 alpha 能修正极性**。正解是换成标签色的纱（见第八节）。

**16. 别在 `<html>` 之外的地方假设 `--dsw-mask-blur` 有值。**
少数 token（`--dsw-mask-blur`、`--dsh-windows-titlebar-height`、`--dsh-frame-*`）确实声明在 `:root` 上，所以它们能在 `html` 上读到。**两类 token 混在一起时，最容易犯的错就是「既然这几个能读到，那些也一定能读到」。** 逐个确认，别推广。

**17. 一个 token 可能有两个画家，而它们在实心主题里是隐形的。**
`sidebarCol` 和 `SidebarRoot` 都画 `--dsw-specific-sidebar-fill`，`centerCol` 和 `ConversationRoot` 都画 `--dsw-alias-bg-base`。因为两层的颜色一模一样，宿主这么写完全正确、也完全看不出问题。换成半透明之后，声明的 alpha 变成 `1-(1-a)²` 落地。**凡是给某个 token 调数字之前，先数一遍有几个元素在画它**（见第六节）。

**18. 「在截图上看效果」不等于「在应用里看效果」。**
`SIDEBAR_FLOOR` 的第一版就是这么错的：把纱合成到截图上挑了一档，看起来正合适；应用里实际显示的是另一回事。**离线合成只能回答「这个数字看起来怎样」，回答不了「应用里显示的是不是这个数字」。** 要回答后者，只有两条路：读计算值（`getComputedStyle`），或者拿真实 CSS + 真实壁纸 + 真实设置渲染一个整窗复刻页再量像素。

**19. 标定好的数字，不要和结构修复塞进同一个版本。**
v2.27.1 同时干了三件事：修双画家、把 `SIDEBAR_FLOOR` 从 40 降到 28、加了中间栏那条规则。用户回来说了四条，其中三条是真的（按钮洗白、侧栏打不开），一条是无关的（模糊）。**分不清是谁干的**，只能靠读宿主 CSS、读 localStorage 里的设置、按 `chatSurface: 0` 推理出「中间栏那条是 no-op」，一条一条排除。一个版本只改一件事，出问题就是二分查找；改两件事，就变成猜谜。

**20. 「按钮没了」不一定是结构坏了，很可能是对比度。**
深色主题的图标和文字是近白色（`#f9fafb`）。侧栏的纱一旦淡到某个程度，白字压在壁纸的亮部上就是「没了」—— 元素还在、还能点，只是看不见。判据：`getComputedStyle` 读出来填充还在（不是 `rgba(0,0,0,0)`），那就是对比度问题，加 alpha；如果填充真的是 0，那才是结构问题。**先分清这两类，再动手。**

## 十三、改了代码之后

```bash
node tools/smoke-test.cjs
```

257 项检查，覆盖：模块契约、样式表注入、壁纸层、**token 捕获在 `<body>`（主题声明处）/ 重混在 `body > *`（既不会读到自己，又覆盖 `#root` 和所有 portal）**、**作用范围（左栏是否被重混）与侧栏 40% 下限**、对话区与输入框独立不透明度、标题栏通栏、标题栏按钮探针、**设置页的重度磨砂（而不是不透明）**及其作用域、**宿主模态的兜底玻璃（`role="dialog"` + `aria-modal` 钩子、填充跟着滑杆走且带上下限、控件换成标签色的纱且只作用于面板内部、零特异性 `:where()`、排在手写配方之前、遮罩保持纯压暗不磨、标题栏接缝补上 `--dsw-alias-bg-mask-1` 且不写死颜色、全表无打包哈希类名）**、**自动玻璃兜底：标记规则、`dialog::backdrop`、探测器的行为（打标记 / 放过小 chip / 半透明 / 渐变 / `<img>` / 隐藏 / 设置页内部 / work-area 不越界 / 开关真的停 / 重渲染后颜色补得回来）**、液态玻璃各档归属与四套配方（面板 / 芯片 / 悬浮控件 / 深色玻璃）、底部状态栏、头部胶囊、用户气泡、费用明细胶囊与头部那颗的隐藏、回到最下面圆钮、侧栏历史块（随内容收缩、行一条规则都没有、三处边缘对齐、关掉宿主 `_fade`、**和计费器共用同一个 `paneFill()`**）、计费器宽度与 Windows 下的按钮内缩、悬停预览卡的玻璃与 50% 填充下限（外加「别再钉回不透明」）、菜单的玻璃画在表面而非材料层、材料层让位、**输入框卡片放弃 backdrop-filter 并把模糊挂到 `::before`**（模糊失效的真凶 + 卡片和菜单同时糊）、右侧侧边栏的玻璃（**只在打开时**）与下层停止画底色、悬停卡的填充下限、**玻璃材料固化后的 30% / 13px（旧设置改不动它，四处表面共用一个数）**、悬停卡与 tooltip 的深色玻璃（描边不用 border）、团队面板（portal 与内层 token 重混）、代码块三处底色与标题栏、标题的「放得下就不滚」与 `max-width` 还原时机、选择器 / 测量方式 / 无缝循环 / 自激防护 / 声明式动效与关键帧、配置页实际渲染、五种字体模式、cost-meter 兼容层、生命周期、CSS 语法与选择器前缀。

**探测器那一节测的是行为，不是自己生成的 CSS 字符串。** 这条规矩是被 v2.24.0 教出来的：那一版断言测的是我自己吐出来的选择器，而真机上类名早就换了、规则一条都没生效，测试还是全绿。凡是「某条规则有没有生效」的判断，能落到假 DOM 上跑的就别只比对字符串。

`--dump` 可打印实际产出的 CSS：

```bash
node tools/smoke-test.cjs --dump
```

跑通后完全退出 DSH 再重开。插件页底部的 `样式 / 激活 / 框架 / 三栏` 四项能区分四类故障：样式表没注入、`<html>` 没标记、框架没定位到、栏数不对。

## 十四、已知边界

- 作用范围靠结构定位（`nth-of-type` + `data-shell-*`），宿主大改布局会失效；失效时插件页会显示提示，且不影响其他界面。
- 只改工作区时标题栏整条是侧栏色。想让壁纸顶到窗口最上沿，就把作用范围切成整窗。
- 标题栏按钮的适配依赖 preload 里那个探针的 `style` 属性原文（用 `[style*="--dsw-specific-sidebar-fill"]` 匹配）。如果哪天 DSH 改成给探针加 class 或用别的变量，这条规则会静默失效——表现为按钮退回实色块，其他一切照常。整窗模式下符号色取的是整张壁纸的平均明暗，不看右上角局部，所以角落特别亮/特别暗时对比度可能不理想。
- 插件管理器页面是重度磨砂；DSH 通用设置页这类**宿主模态**靠 `role="dialog"` + `aria-modal="true"` 兜住（填充 58% 起、跟着滑杆走，模糊 42px），比整页更透一点。钩的是语义属性不是类名，宿主换打包哈希也不会失效；但如果哪天 DSH 把模态改成不带 `aria-modal` 的自绘层，这条会静默退回原样。
- 模态里那几个控件（选择器、步进器、主题卡、选中的导航行）换的是 `--dsw-alias-bg-module-platform` / `--dsw-specific-sidebar-nav-item-active` 两个 token 在面板内部的值。宿主哪天换用别的 token，这几块会退回实心，其它一切照常——不会报错，只是又出现几个「黑框」。
- 捕获层假设 DSH 把 `--dsw-alias-*` 声明在 `body`（浅色 `body` / 深色 `body[data-ds-dark-theme]`）。宿主哪天把这些搬到 `:root` 或别处，捕获会重新变成空值、整层静默失效——**症状和第五节描述的一模一样：一切发白发亮、没有底。** 排查第一步永远是 `getComputedStyle(el).getPropertyValue('--dshbg-raw-base')` 是不是空串。
- 「一个表面只有一个画家」目前只修了侧栏那一条：`frame > div:nth-of-type(1):has([class*="_root"])`（Windows 限定，见第六节）。宿主哪天把列的顺序改了，或者把填充从根搬到别处，守卫会让它退回旧的 64% —— 症状是**侧栏又暗一截**，不是侧栏消失。
- **`chatSurface` 会超发。** `centerCol` 和 `ConversationRoot` 都画 `--dsw-alias-bg-base`，所以滑杆离开 0 之后，实际落地是 `1-(1-a)²`（设 50% 得到 75%）。默认值和常用值都是 0，两层都是透明，看不出来。修法和侧栏一样，但需要一个能把滑杆开到非零的复刻页来验证，见第六节末尾。
- 模态打开时标题栏那条接缝靠 `:has()` 判定，Chromium 100+ 才支持。DSH 的 Electron 远高于这个版本，实际不会踩到。
- `costMeterCss` 依赖 `dsh-cost-meter` 的类名，对方改类名后该规则静默失效（不报错，只是卡片变回实色）。不过自动玻璃兜底会接住它——这正是那一层存在的意义。
- **自动玻璃是启发式的，不是精确的。** 判据只有三条：计算出来不透明、面积 ≥ 7000px²、不画渐变。所以它可能磨到本不该磨的东西（一个本来就该实心的面板），也可能漏掉小面积的黑框。磨错了就关掉开关，其它玻璃效果不受影响。`AUTO_MIN_AREA` 是唯一的灵敏度旋钮。
- 探测器的开销和 DOM 规模成正比，靠分批扫描摊到多帧。极长的会话里，滚动时可能看到某一帧多花几毫秒——扫描只在 DOM 变动后 220ms 的静默期才启动。
