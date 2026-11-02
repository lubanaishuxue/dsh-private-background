# 界面背景 · 实现档案

> **这不是使用说明。** 怎么用、每个滑杆干什么 —— 看 [README.md](README.md)。
>
> 这里是实现记录：为什么这么写、踩过哪些坑、每条断言在钉什么。改代码之前读，改完更新。
> 写作对象是下一个改这份代码的人，不是使用者。

给 DSH 换底图。图片、渐变、纯色三种来源，可调模糊、压暗、面板不透明度，**对话区与输入框各自独立一档**，以及字体颜色。

所有配置都在 **设置 → 插件 → 已安装插件 → 界面背景** 这一页，改完即时生效、自动保存。

**默认只改工作区**：左侧对话列表保持原样，不会被壁纸影响。想要整窗铺满，把「同时应用到左侧对话栏」打开即可。

图片只存在这台电脑上（IndexedDB），不会上传，也不会进入会话记录。

> **版本 1.0.0 —— 第一个正式版。**
> 下面正文里出现的 `v2.x` / `v2.50.0` 是**开发期的内部迭代号**：那段时间每改一处就打一个 tag，纯粹为了改坏了能退回去，不是对外版本。它们按时间顺序都排在 1.0.0 之前，功能上逐层累积成现在这一版。以后对外只报 1.0.x / 1.1.x，内部迭代号不再往上加。


---

## 一、它到底做了什么

四层结构，从下到上：

| 层 | 载体 | 作用 |
|---|---|---|
| 壁纸（下层） | `html::before` | 正在显示的那张。固定定位、`cover`、`blur()` + `brightness()`，`z-index:-1`，永远不透明 |
| 壁纸（上层） | `html::after` | 正在淡入的那张，从 0 淡到 1。没有切换时是空的、`opacity: 0` |
| 语义 token | `body` → `body > *` | 先把主题的 surface token 原值捕获下来，再在 body 的每个直接子元素上重新混成半透明 |
| 面板 | 各组件 | 原本用 token 画底色，于是自动跟着变玻璃 |

**压暗不再是独立一层**，它折进了壁纸的 `filter: brightness()`（第八节 #24）。两者数学上完全一样（`image * (1 - alpha)`），但黑蒙版必须压在**两个**壁纸盒子之上，而 `html` 只有两个伪元素 —— 让出来一个给正在淡入的图，压暗就没地方放了。折进去之后反而更对：交叉淡化时两边各自已经是压暗过的，合成出来仍是压暗的。

关键在于**不是逐个组件改样式**，而是重定义语义 token。凡是用 `--dsw-alias-bg-base` 画底色的东西（三栏、会话容器、输入区、右侧面板）会一起变透明，不需要插件认得它们叫什么。

**重混必须挂在 `body > *` 上，不能挂在框架上 —— 这是「黑框」最大的一处来源。** `#root` 不是整个文档：宿主设置弹窗、计费弹窗、悬停卡、第三方浮层全是被 `createPortal` 到 `<body>` 的，它们是 `#root` 的**兄弟**。挂在框架上的重混永远够不到它们，那些表面就一直按主题原色画，也就是你截图里那几块黑板。

**重混列表要按宿主样式表补全，漏一个就多一块黑板。** 一开始只收了 `--dsw-alias-bg-*` 那几个，结果命令卡的输出体（`GenericCommandCard` 的 `_body`，画 `--dsw-alias-markdown-code-block`）和设置里的模块卡（`--dsw-alias-bg-module-platform`）一直是实心。做法是去 `app.asar` 里统计宿主 CSS 中 `background(-color): var(--dsw-*)` 的出现次数，按排名把「画表面的」那些逐个收进来：

| token | 谁在画 |
|---|---|
| `--dsw-alias-markdown-code-block` | 命令卡输出体、markdown 代码块 |
| `--dsw-alias-bg-module-platform` | 设置里的模块卡 |
| `--dsw-alias-settings-card-fill` | 模块里的偏好卡 |
| `--dsw-specific-menu` | 不走原语的菜单/浮层底色 |
| `--dsw-alias-fill-l1` / `fill-l2` | 通用抬升表面 |

刻意**不**收：`--dsw-alias-interactive-bg-hover*`（交互态，半透明本来就是对的）、`--dsw-alias-state-*`（警示/错误是信号色，磨掉就没意义了）、`--dsw-alias-bg-mask-1`（遮罩）。

## 二、为什么左栏能保持原样

左栏（`.sidebarCol`）画底色用的是 `--dsw-specific-sidebar-fill`，**不是** `--dsw-alias-bg-base`。

所以作用范围是靠**遗漏**表达的，不是靠覆盖：

- 默认：`--dsw-specific-sidebar-fill` 压根不进重混列表 → 左栏仍是主题原色，壁纸在它后面被完全挡住
- 打开「整窗」：把这一项加进重混列表 → 左栏一起变玻璃

这比「给左栏再加一条不透明覆盖规则」稳，因为不需要猜左栏内部还有哪些元素会透。

同理，底部状态栏 `[data-shell-bottom]` 横跨整个网格宽度，在只改工作区时会漏出左栏下方的壁纸，所以它单独被钉回主题底色；整窗模式下则不处理。

**顶部标题栏属于窗口外壳，不属于工作区，所以只改工作区时它保持布局原本的样子：整条铺侧栏色。** 布局把拖拽区画成框架上的 `::before`，铺的就是侧栏色；插件不动它，左栏和标题栏读起来是一整块连续表面，工作区从它下沿开始才是壁纸。

这里曾经用过渐变：到侧栏宽度为止是侧栏色，之后透明，让壁纸从工作区一直顶到窗口最上沿。它只在侧栏展开时成立——布局发布的是侧栏**轨道宽度** `--dsh-windows-sidebar-width`，侧栏一折叠这个值就变成 `0px`，渐变的色标全落在 0 上，整条通栏立刻退回成「全屏壁纸条」，也就是 v2.1.0 当初要修掉的那个现象。**收起侧栏就会复现，所以那个写法等于没修完。** 同一条规则还有第二个毛病：设置页会把自己强制刷成不透明，透明通栏压在深色页面上就是一条亮带。

现在整窗模式下通栏**只承担同样的颜色**：一条硬断的渐变，左半用侧栏浓度（`sidebarFill`）、右半用对话区浓度（`chatSurface`），断点取 `--dsh-windows-sidebar-width`；侧栏收起时该变量是 0，整条自然变成工作区色。

**它不能再带模糊。** 通栏下面的栏是 token 重混出来的玻璃——**只有颜色、没有模糊**。给通栏加 `backdrop-filter`，它就成了「一片糊」，而下面的栏还是「一片清」，边界比不加还跳。这个错误犯过两次：一次是留透明（比下面的栏亮），一次是加模糊（比下面的栏糊）。只改工作区时通栏仍是侧栏色，因为那时壁纸根本不进侧栏。

**弹窗一开，这条线又会回来 —— 因为宿主的遮罩故意不盖它。** 模态遮罩定位是 `inset: var(--dsh-frame-chrome-top) 0 0`，那个变量在 Windows 上正好等于标题栏高度，宿主文档写明「让遮罩不绘制 Windows 顶栏区域」——为的是不压暗原生的最小化/最大化/关闭。于是弹窗打开时：下面全被压暗，顶栏还是全亮，台阶就出来了。

所以有一条配套规则：只要有对话框开着，**顶栏单独补同一层压暗**（取宿主自己的 `--dsw-alias-bg-mask-1`，换主题时两边一起变）：

```css
html[data-dshbg-on]:has([role="dialog"][aria-modal="true"]) frame::before,
html[data-dshbg-on]:has(dialog[open]) frame::before {
  box-shadow: inset 0 0 0 100vmax var(--dsw-alias-bg-mask-1, rgb(0 0 0 / 46%)) !important;
}
```

用 `inset` 阴影而不是 `background`：通栏本来就有渐变底（侧栏浓度 / 对话区浓度两段），这条只往上叠一层压暗，不影响那两段。

## 二·五、所有弹出类窗口跟输入框同一个材料

设置弹窗原本是这套里唯一没有配方的表面，所以它一直是满窗一块近不透明黑板。现在它和菜单、输入框共用同一对数字（`menuFill` / `menuBlur`），只是填充有个 58% 下限——弹窗里全是 13px 正文，太透会伤可读。

钩子用 `role="dialog"` + `aria-modal="true"`，不用哈希类名：那是宿主 JSX 里的无障碍语义，改样式不会动它，而且一次覆盖设置、登录、版本提示、快捷键速查**所有**宿主模态。`dialog::backdrop` 也跟着压暗 + 轻磨。

## 三、对话区和输入框为什么各自一档

面板和正文的诉求是相反的：外壳越玻璃越好看，正文越实越好读。一个滑杆只能取中间值，两边都不满意。

两处各自覆盖自己的 token，而不是在已有底色上再叠一层——两层半透明会合成一个谁都没设过的数，滑杆就没有手感了。

| 位置 | 覆盖点 | 默认 |
|---|---|---|
| 对话区（中间那一栏） | `--dsw-alias-bg-base` | 0% |
| 输入框（`[data-composer-card]`） | `--dsw-specific-input-major`（实心）／玻璃浓度（液态玻璃） | 50% |
| 左侧边栏（整窗模式下） | `--dsw-specific-sidebar-fill` | 40%（独立一档） |

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
| 压在正文上 | **转写区右侧标记的悬停预览卡** | 常开（主题色玻璃，**50% 填充下限**，见下） |

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

**计费弹窗为什么一直是黑板：改错了元素。** 这个插件的统计弹窗有两层类名，`cm-stat` 在外面、`cm-stat-dialog` 在里面，而**真正画底的是外面那个**：

```css
.cm-stat { background: rgb(from var(--dsw-alias-bg-layer-2) r g b / 1); }
```

那个 `/ 1` 把 alpha 强制拉满（老问题），所以只重定向内层 `cm-stat-dialog` 时，外层仍然铺着一张 100% 不透明的纸——内层再怎么半透明，合成出来还是黑。现在两个都重定向，并且**嵌套时让内层停止画底**（`body .cm-stat .cm-stat-dialog { background: transparent }`），避免两层玻璃合成 `1-(1-a)²`；如果两个类落在同一个元素上，这条规则不匹配，外层规则就是唯一的画师。

**弹窗为什么看着像黑板：不是漏了不透明元素，是三层深色叠出来的。** 拿一张真实截图量过像素：弹窗内部上缘 `(47,58,72)`、下缘 `(44,45,51)` —— **跟着背后的壁纸在变**，说明玻璃一直在生效。真正的问题是它坐在一块被压黑的背板上：

| 层 | 原值 | 现在 |
|---|---|---|
| 弹窗背后整棵树 `#root` | `brightness(0.52)` | **0.95**（只保留 3px 模糊做前后分离） |
| 弹窗遮罩 `::backdrop` | 46% 黑 | **26%**（计费器弹窗 18%） |
| 弹窗自身浓度下限 | 58% | **38%**（= 面板不透明度 + 10） |

三层相乘时颜色被压到 `(45,50,60)`，肉眼就是黑；现在背板基本不再压暗，玻璃才有东西可透。**量出颜色这一招比看截图猜层叠可靠**：只要弹窗内部两个采样点的色差跟外面对得上，就说明它是半透明的，问题一定在亮度链条而不是选择器。
**最终归宿：直接改它自己。** 上面两条（重定向类名、JS 内联 `!important`）在真实环境里都没能让弹窗变亮——它的规则来自插件自己的样式表，永远比我们后插入的那张更靠近宿主。所以改成在安装好的插件里打补丁：

```bash
node tools/patch-cost-meter.cjs          # 打补丁（幂等），备份在同目录 *.dshbg-orig
node tools/patch-cost-meter.cjs --revert # 还原
```

补丁做的事：在它的弹窗规则后面追加一条**浅色磨砂**——

```css
body :is(.cm-stat-dialog,.cm-qguide,.cm-peak-alert), body dialog.cm-fee-dialog {
  background: color-mix(in srgb, #ffffff 14%, transparent) !important;
  backdrop-filter: blur(46px) saturate(150%) !important;
  box-shadow: 0 28px 90px -34px #000000cc, inset 0 0 0 1px #ffffff24 !important;
  --cm-opaque-base: transparent;
}
body .cm-stat { background: transparent !important; }
body .cm-stat-dialog::backdrop { background: #080a0e59 !important; }
```

关键在于用**浅色**而不是深色：无论背后的壁纸被压得多暗，白色 14% 的磨砂都读作玻璃，而任何深色填充在暗背景上都会读作黑板。这是前四轮全部没效之后，一次肉眼可见的变化。

那个包的 CSS 是压缩过的：`!important`、token 名、整个声明都被替换成 `ƀ`–`ǿ` 区间的单字符。**直接追加纯 ASCII 是安全的**（解码器只替换那些字符），而且追加在出错规则之后天然赢得层叠。补丁脚本先查签名，重复运行不会叠两层。

代价：插件重装/升级会覆盖这段补丁，重跑一次脚本即可；脚本找不到锚点时会**报错退出**而不是猜。


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

**输入框的模糊画在卡片自己身上，菜单开着时卡片让出模糊。**

先前的两种写法都不行，而且失败方式一样：填充渲染了、**模糊从没上屏**。

1. `::before` + `isolation: isolate`（伪元素 `z-index: -1`，卡片建 stacking context）；
2. `::before` + `z-index: 0`（把 `isolation` 换成不在 backdrop root 清单上的属性）。

现在用转录区卡片验证过的那条路——**元素自带 `backdrop-filter`**——然后按状态裁决唯一的冲突：

```css
[data-composer-card] { background: color-mix(... composerSurface%); backdrop-filter: blur(menuBlur) saturate(160%); }
html[data-dshbg-menu] [data-composer-card] { backdrop-filter: none; }
```

`/` 命令菜单渲染在卡片**里面**、挂在卡片上方，而卡片一旦有 `backdrop-filter` 就成了 backdrop root，菜单只能采样 root 内部（空）。`installComposerMenuGuard` 每 120ms 最多查一次 `[data-composer-card] [data-menu-material]`：菜单开着就摘掉卡片的模糊、让菜单拿回自己的，关掉再还回来。代价写在明处——菜单开着的那几百毫秒，输入框没有模糊。

**浓度用 `composerSurface`（「输入框不透明度」），不是 `menuFill`。** 这是唯一一处光标停在文字上的表面，所以它自己一档，而且实心/玻璃两种质感共用同一个数。之前玻璃模式读的是 `menuFill`，于是那条滑杆在玻璃下完全没反应——「输入框不透明度改动没反应」就是这么来的。

对照页 `diag/card-pseudo.html` 记的是当年那次测量：卡片自己带模糊 → 卡片糊了但菜单背后清清楚楚。结论（祖先的 `backdrop-filter` 会切断后代采样）依然成立，所以现在才需要那个状态裁决。

**右侧侧边栏**（dockkit）结构是反的：`[data-sidebar-right-panel]` 这个根是个裸的 `position: absolute` 盒子，**自己一点底色都没有**，可见的面画在更下层的 `[data-dockkit-host]` / `[data-dockkit-pane]` 上。所以玻璃铺在**根**上，然后把下面几层的 `background-color` 设成 `transparent` —— 否则宿主的填充会盖在玻璃上，什么都透不出来。

**而且必须用 `[data-sidebar-right-open]` 把它门住。** 这个根是**常驻**的：侧栏收起时它照样占着那一列的宽度，只是把内容 `transform: translateX(var(--dsh-sidebar-width))` 推走 + `visibility: hidden` 藏起来 —— `visibility` 不影响布局。所以无条件给根铺底色，就会在侧栏根本没打开的时候糊一大块玻璃盖在对话上（实测就是这样翻的车）。`data-sidebar-right-open` 是宿主在打开期间挂的布尔属性，门住它。

菜单和右侧栏共用 `menuFill` / `menuBlur` 这一对（同一种材料，必须一起动）；输入框的浓度走自己那条，理由见上。

**左侧边栏为什么是黑的。** 那一列被画了**两次**：宿主先用 `--dsw-specific-sidebar-fill` 给列铺一遍，它的内层根又用**同一个 token** 给自己铺一遍。声明 40% 落到屏幕上就是 `1-(1-0.4)²` = 64%，于是左栏永远比旁边的面板暗一档，看上去就是一块黑板。整窗模式下现在让**内层根**当唯一的画师（列停止画底色，用 `:has([class*="_root"])` 做联锁），并且给侧栏单独一条 `sidebarFill`——它和面板不透明度分开，正是因为这一列的历史就是这个数字对不上屏幕。要整块关掉侧栏玻璃，把「整窗铺满」关掉即可（那时壁纸根本不进侧栏，左栏回到主题原色）。

**填充量到多少合适？** 下面这张表是在**模糊还死着**的前提下量的（壁纸亮部 + 13.5px 正文）——所以它量的是「没有模糊时，多厚的色板才能压住字」，不是玻璃的参数：

| 填充 | 合成底色 | 正文对比度 | 面板亮度 / 起伏 |
|---|---|---|---|
| 100%（不透明） | `#232324` | 8.5:1 | 35 / **0.00** |
| **76%（当前默认）** | `#303c45` | **6.1:1** | 63 / 12.5 |
| 62% | `#374b58` | 7.1:1 | 79 / 20.0 |
| 45%（宿主原值） | `#4f6c80` | 3.0:1 | 113 / 28.4 |

62% 的对比度反而比 76% 高（底色更亮、白字更亮）——**只看对比度会选错档**。当时的判据是「背景大字能不能被抹掉」：壁纸上那行 60px 的时钟，40px 模糊下抹不掉，62% 能看见鬼影。**但那个「抹不掉」本身就是模糊失效的症状**——模糊真工作之后，40px 连 60px 的字都能抹平。所以这张表只能当「最坏情况的下限」看，真实取值交给滑块量。

> **⚠️ 这两个数字已经定稿了（v2.49.0）：`menuFill = 30` / `menuBlur = 50`。**
>
> 它们曾经是设置页上并排的两条「临时」滑块，因为**填充和模糊是一对，不能单独调**：半径越大背景磨得越平，压住文字所需的填充就越少，而填充越少才越像玻璃。40px（宿主真值）恰好是「壁纸糊成一片平色、认不出形状」的那一档，这既是当初被迫把填充推到 76% 的原因，也是「玻璃感不强」的另一半。
>
> 两个数字现在写死在 `DEFAULTS` 里，滑块删了。要改就改那两行；`menuSurfaceCss` 读的仍然是 `settings.menuFill` / `settings.menuBlur`，`readSettings` 的 clamp 也保留 —— 老用户 localStorage 里存的值继续生效，只是没有 UI 能改它了。
>
> 冒烟测试里 `menu fill follows the setting, not a literal` 仍然守着这条链路：它 emit 一个不同的值，断言样式表跟着变。默认值恰好等于固化值，所以其他断言在「改回写死字面量」的情况下照样会过，只有这一条会炸。

**转写区常开**：它们是内容不是外壳，压在工作区的壁纸上面。一块实色卡片铺在壁纸中间，读起来就是画面上打了个洞。所以「质感」切回实心只说明输入框要实心，不该连带把整篇对话里的代码块和文件卡都拉回实色。

**转写区右侧那排标记的悬停预览卡，走的是「压在正文上」那一档，不是 pane。**

鼠标移到转写区右边那排小标记上，会弹出「这一问 + 三行回答」的预览卡（`xpvNua_preview`，`width: min(300px, 100cqw - 120px)`，一行 13px 粗体问句 + 最多三行 12px 回答）。它画的是 `--dsw-alias-bg-layer-1`，而这个 token **在**重混列表里。

这段历史值得记，因为它翻转过两次：

1. 最早没有专门规则 → 卡片跟着面板那一档掉到 ~28% → 背后的正文原样穿过来，预览看不清、被盖住的那段正文也看不清。**这时「透明度不是风格而是 bug」是对的。**
2. v2.16 的修法是把捕获的原始 layer 值钉回去，也就是**完全不透明**。读是能读了，但整窗就剩这一块实心黑方块——用户截图一眼挑出来（实测卡片内部像素 `(35,35,36)`，纯 `#232324`）。
3. 现在是玻璃：共享两条临时滑块的填充和模糊，但**填充有 50% 硬下限**。它和悬停卡是同一类表面（都是压在内容上的浮层），所以用同一个下限。

能这么做的前提是**它没有带 `backdrop-filter` 的祖先**。卡片是 `_scroller` 的**兄弟**不是子节点（`<nav> > [scroller][marks] + [preview]`），`_slot` 的 `container-type` 和 `_frame` 的 `contain: layout` 只建包含块、不建 backdrop root。**哪天这里的模糊又「没生效」，先查这条祖先链**（见第七节踩坑 #10）。

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

**但 `_bannerWrap` 这个壳本身必须留底色。** 宿主给它的是 `position: sticky; top: 0; z-index: 6`，也就是说宿主把它当「盖住滚动代码的板子」在用。跟着 `pre` 一起清成 `transparent` 的后果是：滚动时两行代码直接叠在语言标签和复制按钮上。它现在借的是**对话框的材料**（`composerSurface` + `menuBlur`），详见第八节第 12 条。

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

**用户气泡是内容，所以常开。** 它画 `--dsw-specific-bubble`，同样不在重混列表里，暗色主题下就是一块不透明深灰。归属跟文件卡、代码块一致：它属于转写区，所以「质感」切回实心不影响它。

**要认三个 flow kind，不是一个。** 会话里只有**第一条**用户消息是 `data-chat-flow-kind="user"`；中途追加的提示词是 `steering`，排队跟进的触发是 `turn-trigger`。只写 `user` 就会得到「只有第一句有玻璃、后面几句都是实心」——这行为看着像 bug，其实是选择器少认了两个 kind。另外补一条 `[class*="_userRow"] [class*="_bubble"]` 兜住宿主以后可能新增的 kind：`_userRow` 是包住这个气泡的那一行，别处没有。

`_bubble` 这个本地名在别的模块里也有（轨迹、终端、目标输入、提问回复），所以每一档都必须带 flow kind / row 收口，不能裸写。

**交付卡为什么要这么绕。** 它画的是 `var(--deliverable-fill)`，而那是 `--dsw-static-neutral-850` ——**静态中性色，不是语义 token**，所以 token 重混这条路径根本够不到它，卡片一直是实色。只能整块铺玻璃。但光写 `[class$="_file"]` 会误伤另外两个同名尾巴：输入框里 24px 高的附件片（`v1kfCW_file`）和变更文件行（`PWz36q_file`），给它们套玻璃只会变成两块怪斑。交付卡自带一个 `_fileBody` 直接子节点，另外两个没有，于是用 `:has(> …)` 把它挑出来。首选钩子其实是卡上的 `data-presented-file`，类名那套留作后备。

**内联 code 芯片是另一套配方，不是缩小的面板。** 它画的是 `--dsw-alias-markdown-inline-code`，同样不在重混列表里，所以一直是实色芯片。跟大面板比改了三处，全是因为它只有 20px 高、一屏出现几十次：

- **填充更重**（45%，面板是 22%）。芯片必须跟正文区分开，22% 会直接糊进壁纸，那串等宽字就不再像一个 token 了。45% 是 12px 等宽字在亮色 label 下还能守住 5:1 的地方——再低就只剩好看。
- **去掉投影**，只留顶部内高光。一段话里飘十几个投影纯属噪音，发丝边已经足够把它从页面上托起来。
- **模糊封顶 10px**。背景本来就在 `html::before` 上糊过一遍，更大的半径买不到观感，只会乘以屏上芯片数量。
- **边框保持 `.5px`**，只换颜色。改成 1px 会让每个芯片的盒子各胖 1px，而它们是内联元素——一段话里上百个芯片就是上百次行内重排。

**`$=` 和 `*=` 不是可选项。** 新会话按钮的类名是 `<hash>_newSession`，用 `[class*="_newSession"]` 会把它的四个子节点一起选中——`_newSessionContent`、`_newSessionLabel`、`_newSessionLabelMask`、`_newSessionShortcut` 全都含这个子串，结果是标签和快捷键提示各自套上一层边框和投影。类名是整串匹配（元素只有一个 CSS module 类名），所以 `[class$=…]` 才是精确的那个。

代码块的 `pre` 和 banner 那一**行**（`_banner`）各自会再画一遍块底色，两处都要清空，否则磨砂只做了一半——四周是玻璃、中间一块实心。但 banner 的**壳**（`_bannerWrap`）恰恰相反：它是 sticky 的，必须留底色和模糊，否则滚动时代码会从它下面透出来。

**注意模糊挂在哪一层**：代码块的 `backdrop-filter` 在 `pre` 上，不在块上。块要是带了 `backdrop-filter` 就成了 backdrop root，表头作为它的后代只能采样 root 内部（空的），模糊静默失效——详见第八节第 12 条。

壁纸本身在 `html::before` 上已经糊过了，所以面板自己的 `backdrop-filter` 主要是补饱和度、给边缘定形，不是靠它做模糊。这样长对话里几十个代码块也不会把 GPU 拖死。**表头是唯一的例外**：它下面有会动的代码，那层 `backdrop-filter` 就是用来糊掉它们的，不是装饰。

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

## 三·五、每个背景各记一套参数

v2.50.0 之前所有背景共用一套滑杆：把 A 图调成模糊 5，切到 B 图还是 5。可是同一个模糊值压在夜色图和一张白底纸上，读起来是两回事——**参数其实是背景的属性，不是应用的属性**。

现在每张图、每个渐变预设、每个具体色值、以及「关闭」状态，各有一份自己的呈现参数。切走时存下，切回来时取出。

| 跟背景走（每份一份） | 全局（所有背景共用） |
|---|---|
| 模糊、压暗、面板不透明度、对话区不透明度、输入框不透明度、输入框质感、菜单填充、侧栏浓度 | 玻璃模糊、菜单模糊、作用范围、字体、字体颜色 |

分界是**"这张图长什么样"还是"界面长什么样"**。玻璃模糊是材质：一个对话框随背后的图换磨砂强度，读起来像 bug 而不像功能。字体和作用范围同理。

### 存储形态

`localStorage` 里的 `settings.v4` 是一份**文档**，不是一份扁平设置：

```jsonc
{
  "mode": "image", "imageId": "img-…", "gradient": 0, "color": "#1b2233",  // 指针
  "presets": {
    "image:img-…": { "blur": 5, "dim": 40, … },
    "color:#1b2233": { "blur": 7, … },
    "gradient:2": { … },
    "none": { "blur": 33, … }
  },
  "base": { … },                                        // 迁移来的那套，所有来源的兜底
  "glassBlur": 40, "menuBlur": 50, "fullWindow": false, "font": "theme", "fontColor": "#f7f8fa"
}
```

来源的 key 就是身份：`image:<id>` / `gradient:<序号>` / `color:<#hex 小写>` / `none`。**颜色按色值算，不是"纯色模式"整体一套**——`#1b2233` 和 `#0d1117` 是两个来源。

### 三个坑

**① 扁平视图是派生的，不是存下来的第二份。** `settings.blur` 每次 commit 从 `presets[当前来源]` 重算（`flatten(raw)`），跟 `activeImage` 同一个形状。如果让它当一份独立存储，就正好复刻 v2.48.3 那个 bug：改的时候只写了一半，切换后要刷新才对齐。

**② 加了新滑杆就必须归类，否则它被静默丢弃。** `applySettingsPatch` 只认 `POINTER_KEYS` / `PRESENTATION_KEYS` / `GLOBAL_KEYS` 三张名单里的键；名单外的键**不报错、不生效、下一帧弹回原值**。冒烟测试里那条「every default is classified into a group」就是钉这个的。

**③ 新传的图继承当前那套，不是回到出厂值。** 传图的意图是换画，不是换风格。实现上 `addImage` 把当前 preset 复制一份挂到新 id 上，所以之后两者各改各的，不会互相影响。

**迁移**：老用户第一次启动时读不到 v4，就退回读 v3 那份扁平设置，把它当作 `base`。于是**除了当前那张，其他图第一次被点到时用的是他之前调好的样子**，而不是出厂值。v3 的键原样留着，回滚旧版本也不会丢设置。

## 四、设置页为什么不铺底

它曾经是**不透明**的，理由是「壁纸压在 12px 控件后面读不清」。但铺的是 `--dshbg-raw-base`——主题的近黑中性色，于是：打开这个插件自己的页面，你刚设好的壁纸整个消失在一块黑板后面。而这一页恰恰是你唯一想看看壁纸效果的地方，所以现在改成**什么都不铺**。

「哪一栏是设置页」仍然不能靠猜 DOM：配置页挂载时给 `<html>` 打 `data-dshbg-config`，卸载时移除。样式表据此把壁纸覆盖的那部分（只改工作区时是中右两栏，整窗模式是整个框架）刷成 `transparent`，壁纸直接透上来；页面自己的控件各自带玻璃，读得清。

只认 `view === 'page'`，因为同一个组件在插件列表里也会以 summary 形式渲染一次——那种情况下不该动整页。

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
├─ 状态        state + subscribe / commit / patchSettings（activeImage 每次 commit 从 images + imageId 重算）
├─ 选择器      frameSelector / workAreaColumns / bottomRowSelector
├─ 样式        wallpaper / token / chatSurface / composer / glass / chrome / caption / bottomRow / font / configPage / costMeter
├─ 安装        installStyles（apply 内注入 <style>，ctx.effect 托管清理）
├─ 组件        Switch / Segmented / Slider
└─ 页面        ConfigPage（注册到 plugins.bundle.config）
```

## 八、踩过的坑（改动前务必看）

> **读这一节之前先知道一件事**：下面有几处提到「调参卡里的某个读数」。那张卡在 v2.49.0 删掉了（见第九节），所以那些读数现在没有 UI。它们描述的是**当时怎么定位的**，结论仍然成立，代码不在 —— 要复现那个手段，`git show v2.48.3:client.js` 里整块都在。

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

**12. sticky 的表头是「盖子」，遮住它下面东西的是模糊，不是填充。**
代码块表头壳 `_bannerWrap` 在宿主里是 `position: sticky; top: 0; z-index: 6`，底色 `var(--dsw-alias-bg-base)`——宿主把它当**盖住滚动代码的板子**。插件把它跟 `pre` 一起清成 `transparent`，于是滚动时两行代码叠在语言标签和复制按钮上。**看起来像 sticky 坏了，其实是表头透明了。**

修的时候我先走错了一步：以为「填充够黑就能盖住」，把填充推到 86%，得到一条几乎实心的黑带。用户的反馈是「现在不行，回滚」——他要的是**跟对话框同一种材料**。

**真正遮住代码的是 `backdrop-filter`。** 50% 填充下代码文字依然清晰可读，`blur(50px)` 一上去它就彻底消失。分工是：**填充决定「这层有多暗」，模糊决定「下面还有没有东西」**。所以「填充要多少才够」这个问法本身就是错的——先问模糊够不够。

现在表头直接借对话框的两个值（`composerSurface` + `menuBlur`），不自己另立数字。好处是用户调一次滑杆，两处一起动，不会分家。断言也是这么写的：从同一张样式表里把对话框的值读出来比对，而不是写死一个数字。

**⭐ 但借了值之后模糊还是没发生——因为插件把代码块整块变成了 backdrop root。**

`glassPane()` 里带 `backdrop-filter`，而代码块（`.md-code-block` / `[class*="_block_"]`）一直套着它。于是**整块**成了 backdrop root，表头 `_bannerWrap` 是它的**后代**、`pre` 是它的**兄弟**——表头去采样，采到的是 root 外面，**静默失效，没有任何报错**。填充（`background-color`）不受 backdrop root 影响，所以现象是「填充立刻可见、模糊毫无变化」，特别像「模糊数值太小」。

这跟第七节 #10 是同一个病，只是这次 root 是插件自己造的、挡的是自己的另一个元素。**症状一模一样：模糊没效果，先查祖先链，别调数字。**

改法是把模糊从块挪到 `pre`：块用 `glassPane(blur, false)` 只留外壳（填充 + 边框 + 阴影），`pre` 单独挂 `backdrop-filter`。块照样是磨砂的（`pre` 在里面糊），表头隔着 `pre` 也能糊。`withBlur` 这个参数只给代码块用，别拿去「简化」别处——没有自己模糊的面板只是一块染了色的矩形。

复刻页 `diag/code-sticky.html` 两个开关直接对照：`?blockglass=1` 复现（代码压到表头上）、`?preglass=1` 验证（表头干净）。三栏对照图 `diag/code-banner-3way.png`——第三栏能看见表头下面那一行代码是糊的，那才是模糊真的在干活。

⚠️ `[class*="_banner"]` 同时命中 `_bannerWrap`（壳）和 `_banner`（行）。壳要留底色、行要让出去，两条规则必须分开写，顺序不能反。

⚠️ **验证模糊必须用对的无头参数。** 第一轮我用 `--disable-gpu` 启动 Edge，`backdrop-filter` **静默失效**（不报错、不警告），于是 50% 填充下代码清清楚楚，我据此得出「50% 盖不住、必须 86%」的错误结论。改用 `--enable-unsafe-swiftshader`（不加 `--disable-gpu`）后模糊立刻生效。**判据：无头里模糊看起来完全没效果时，先查启动参数，别急着改数值。** 这条和「离线合成 ≠ 上屏值」是同一类错误的两副面孔：都拿一个不成立的观测去推一个真机的结论。

**13. 别在 `#root` 上写 `filter`，也别给 `::backdrop` 加 `backdrop-filter`。**

起因是一个「本地模型跑起来之后，鼠标放到用量上，对话框会闪」的报告。

第一轮我判断是 `backdrop-filter` 的快照成本，让用户把两条模糊滑杆都拖到 0 —— **闪烁照旧**。那次测试无效，原因在下面第 3 点。

三条要记住的：

1. **`#root` 是整个应用。** 在它身上写 `filter`，等于每帧把整窗重算一遍；流式输出时就是每帧一次，GPU 再被本地模型占着，就丢帧。它还会创建包含块，静默破坏后代的 `position: fixed`。**壁纸在 `html::before` 已经糊过一次了，在它上面再糊一次只是把糊了的东西再糊一遍**，什么也没买到。现在 `#root` 上一个 filter 都没有 —— `brightness(0.95)` 也去掉了：filter 只要在 `#root` 上，它就是一整个渲染表面，为 5% 的压暗付这个价不值得，宿主自己的 scrim 本来就在压。

2. **`dialog::backdrop` 铺满整个视口。** 给它加 `backdrop-filter`，合成器就要对整窗拍快照并模糊，同样每帧一次。`::backdrop` 只需要压暗，不需要磨。

3. ⚠️ **上面这两处都是滑杆够不到的，所以「拖到 0 还闪」不能证明模糊无关。** `#root` 的半径当年写成 `min(10, max(4, menuBlur / 12))` —— `menuBlur` 是 0 也照样输出 `blur(4px)`；`::backdrop` 的 `blur(6px)` 是写死的。**做隔离测试之前，先确认你关的那个旋钮真的能把这个值关到 0。**

还有一处同类但没动：费用明细弹窗自己的 `backdrop-filter: blur(46px)` 写死在 cost-meter 的补丁里，也不受滑杆控制。它只在弹窗打开时存在，先留着观察。

**14. 真 `border` 会把盒子撑宽 2px，而 2px 足够让两条滚动条互相喂饭。**

一条更早的观察把方向指对了：闪的时候**底下那条横向滚动条也在闪，节奏还错开**。

两个东西各自闪、相位错开，是**两条滚动条互相喂饭**的指纹：横向那条占高度 → 竖条的高度预算变了 → 竖条一出现又占宽度 → 横条的宽度预算又变了。这个循环的启动条件是「有东西真的比自己盒子宽」，而它一旦转起来，内容就会持续 reflow —— 看起来就是整片在闪，且跟流式输出不同步。

插件里最容易造出这 2px 的就是真 border。宿主**没给这些盒子写 `box-sizing: border-box`**（侧栏的行是 content-box），所以 `border: 1px solid` 会把盒子撑宽 2px。这条规矩本文件第 1281 行附近就写着「描边一律 inset 阴影不用 border」，但三套配方一直在违反它：`glassPane`、`glassFloat`、`composerGlassCss`、`dialogCss`。现在四处全部改成 `inset 0 0 0 1px` 环形阴影——环画在内侧而不是外侧，视觉几乎一致，布局彻底中性。

⚠️ 这类问题的**诊断顺序**：不要先猜哪个元素在闪，先量「谁比自己盒子宽」。当时调参卡里有一行 `overflow` 探针，列出 `scrollWidth > clientWidth` 的元素（带类名和溢出像素数），读它的名字比看截图快。

**15. 「闪」这种报告，先把它变成数字，再改代码。**

同一件事连改三轮都没修好，原因不是笨，是**每一轮都在盲改**：没有一次能说清「这一帧到底丢没丢」。所以当时的调参卡里有两个读数，配合一个开关：

| 读数 | 判读 |
|---|---|
| `frame = 最差 120ms · 掉帧 3` | 一帧都没丢（最差 ~16ms、掉帧 0）→ 闪烁的东西**是被画出来的**，问题在 DOM / 状态，不在合成 |
| | 真的丢帧（最差 > 50ms、掉帧 > 0）→ 是合成成本，用开关一刀切 |
| `overflow = div.cm-footer-stack.summary +18 · …` | 谁比自己盒子宽，带类名和像素数。横向滚动条的来源 |
| 勾上「关掉所有模糊（排查用）」 | 本插件写的每一个 `filter` / `backdrop-filter` 变 `none`（含壁纸那层）。填色圆角描边都不动，所以窗口还是这个样子 |

**为什么非要这个开关，滑杆不行？** 因为滑杆够不到所有声明，而且 `blur(0px)` 本身仍然是一个 backdrop root —— 半径 0 和「真的没有」在合成器眼里是两件事。前两轮就是栽在这里：用户「把滑杆拖到 0」，实际输出还是 `blur(4px)` / `blur(6px)`，于是得出「模糊无关」的错误结论。

实现上它靠一个独立属性 `data-dshbg-flat`，规则写在 `buildCss` 的**最后一条**，用「更晚 + 更高特异性」压过上面所有配方 —— 不需要让每个配方都长一个 `if`。断言里有一条专门钉这个顺序。

**16. 诊断工具不能挂在看不见的座位上。**

调参卡原来（现在已删）是注册进宿主 `sidebar.footer.action` 座位的一个 React 组件。v2.45.6 之后那个座位突然什么都不产出了：`localStorage` 里 `showDock` 明明是 `true`（leveldb 里能按字节读到），组件单独调一遍渲染正常，侧栏就是不见东西 —— 用户看到的是「按钮按了没反应，左侧不显示」。

这个故障最要命的地方在于**它把唯一的诊断手段一起弄没了**：`frame` / `overflow` 读数、那个「关掉所有模糊」的开关，全在那张卡里。卡不出来，后面所有排查都做不了。

所以当时把卡改成了**普通 DOM，`position: fixed` 挂到 `document.body` 上**，不再经过任何 slot（这张卡后来在 v2.49.0 整体删掉了，下面五条是它当时的约束）：

- 插件只要 `apply` 跑起来，卡就在屏幕上。座位在不在、宿主的 flex 怎么排、`#root` 里发生了什么，都跟它无关。
- 它自己就是 `body > *`，会被本插件自己的重混命中 —— 所以底色**写死**（`rgb(32 33 36 / 97%)` / `rgb(255 255 255 / 97%)`），不读 `--dsw-alias-*`。读 token 得到的是半透明的那一份，读不清的读数比没有读数更糟。颜色在每次 `sync()` 里重算，主题翻转能跟上。
- `bottom: 64px` 而不是 `12px`：左下角正是宿主自己的「设置」按钮和计费器那一行，诊断卡不能把那一下点击吞掉。
- DOM **建一次然后 sync，不在每次 commit 时重建** —— 换掉一个正在拖的 `input[type=range]` 会当场结束拖拽。同理，指针正按着的控件绝不回写值。
- 滑杆走 `input` 事件而不是 `change`：`change` 只在松手时来一次，那就不是「拖到哪儿看到哪儿」了。

「插件能不能渲染出一个座位」和「插件有没有在工作」是两件事，**诊断工具必须只依赖后者**。卡虽然删了，这条判据没有过期 —— 它现在体现在设置页那行 `样式 / 激活 / 框架 / 三栏`：那四项只依赖「插件跑起来了」，不依赖任何宿主座位。

**17. 壁纸层的盒子不能用 `inset`，因为滚动条会让整屏模糊重算一次。**

用户勾上「关掉所有模糊」之后回了一句「就不闪了」。这句把范围从「不知道」缩到了「模糊」，但也到此为止 —— 插件里有两笔完全不同的模糊账：

- **整屏一笔**：`html::before` 上的 `filter: blur(50px)`，一张「视口 + 2×112px」的图，每次重做都是全屏高斯。
- **每块一笔**：面板 / 输入框 / 菜单 / 代码块的 `backdrop-filter`，各自要一份 backdrop 快照。

**一笔都关掉才能不闪，说明不了一笔都不行。** 所以当时在调参卡上加了第二个开关，只关壁纸那笔（`data-dshbg-noblur`），面板的快照照旧 —— 一次点击就能把两笔分开。

但真正的根因在几何上，不在数值上。壁纸层原来写的是 `inset: -112px`：

```css
/* 改之前：尺寸 = 视口 + 224，而「视口」不含滚动条 */
html[data-dshbg-on]::before { position: fixed; inset: -112px; filter: blur(50px); }
```

`inset` 相对**包含块**解析，包含块宽度是视口宽（不含滚动条）。流式输出时正文变长 → 某个容器开始溢出 → 横向滚动条出现或消失 → 包含块矮/宽 15px → 壁纸盒子尺寸变 → **整屏 `filter: blur(50px)` 从零重做一次**。同一次重绘里，正文列里那些 `backdrop-filter` 元素正等着采样这一层，采样没就绪就画成透明 —— 正文列背景本来就只有半透明填充，于是**一帧里整列只剩壁纸**，而左栏内容没变、不需要重绘，所以完好。这也解释了「横向滚动条和正文列各自闪、节奏错开」：它们是同一条因果链上的上下游。

`vw` / `vh` 相对**初始包含块**解析，而初始包含块**含滚动条槽**。实测（`diag/vw-probe.cjs`，无头 Chrome 必须加 `--disable-features=OverlayScrollbar` 才有占位滚动条）：

```
innerWidth 758 · clientWidth 743 · 滚动条 15 · width:100vw 的探针 = 758
```

即 `100vw` 含滚动条。于是 `diag/wallpaper-geometry.cjs` 量到两种写法在横向滚动条出现前后：

| 写法 | 无横条 | 有横条 |
|---|---|---|
| `inset: -112px` | 982×706 | 982×**691** ← 变了 |
| `width: calc(100vw + 224px)` | 982×706 | 982×706 ← 没变 |

两条规则画出来的盒子在静止状态下一模一样（982×706），所以这个改动**视觉上是零变化**，只改了对什么变化敏感。再补一条 `will-change: filter`，让剩下那些（窗口缩放、换图）也走缓存而不是每帧重算。

⚠️ **`fixed` 定位的元素不参与滚动区域计算**，所以盒子比视口宽 15px 不会凭空长出一条横向滚动条 —— 这是这条路能走通的前提。

⚠️ 调参卡里当时那三个 `+718`（`acoR2W_panel` / `acoR2W_panelBody` / `_surface_6nhg2_125`）是**宿主的固有状态，不是本插件的 bug**：右侧栏收起时它用 `transform: translateX(var(--dsh-sidebar-width))` 移出画面，`transform` 会扩大 scrollable overflow area，而容器自己 `overflow: clip` 不产生滚动条。718 ≈ 用户右侧栏的宽度。**读 `overflow` 时要分清「谁真的能滚」和「谁的 scrollWidth 更大」**。

⚠️ **这条不是那次闪的原因。** 当时我以为找到了根因，用户下一句就是「所有情况都是只有关闭全部模糊才不闪」—— 只关壁纸模糊照旧闪。所以壁纸的整屏 `filter` 是**隐患**（它确实会因滚动条重算，确实该改），但不是那一次闪烁的**元凶**。真正的元凶是第 18 条。

**这也是「先改再验证」的代价**：`vw/vh` 这个改动本身是对的、零视觉变化、值得留，但如果我当时就宣称「找到了」，就会错过真正的原因，还会让下一个人以为这条路是必要的。**修好了一个真 bug，不等于修好了你正在追的那个 bug。**

**18. 面板底下的东西已经糊过了，所以面板不该再糊一遍 —— 而且每糊一遍都是一次快照。**

用户最后一句：「所有情况都是只有关闭全部模糊的情况下才不闪」。两个开关（全关 / 只关壁纸）都试过，只有全关才不闪 —— 所以元凶是**每块面板自己的 `backdrop-filter`**。

想清楚它为什么多余：壁纸在 `html::before` 已经 `blur(Npx)`，所以一个面板底下的「背景」**本来就是一张糊图**。面板再对它 `backdrop-filter: blur(40px)`，是在糊一张已经糊了的图 —— 视觉上买到的东西接近零（只多糊了一点，反而让面板比周围壁纸更哑），代价是**每帧一次全尺寸快照**。

而快照的代价不是「慢」，是**「没有」**：Chromium 给每个 `backdrop-filter` 元素按它的 backdrop root 开一张 surface，某帧这张 surface 没就绪，那片区域就是**空白**。流式输出时正文列每帧重绘 → 快照每帧重拍 → 输掉的那一帧整列只剩壁纸，而左栏没在重绘所以完好。`frame` 读数是**掉帧 0**，也正好对上：不是性能不够，是那一帧画错了。

所以按「底下是什么」重新分类：

| 底下的东西 | 要不要 `backdrop-filter` | 谁 |
|---|---|---|
| 糊过的壁纸 | **不要** | 侧栏 pane（新会话按钮 / 计费器 / 历史块）、右侧栏、文件卡、交付物、用户气泡、changed 文件卡、代码块 `pre`、inline code、状态行 dock、header 芯片、`.cm-btn` |
| 真的内容 | **要** | 菜单、悬停预览卡、悬停卡、tooltip、sticky 表头、输入框卡片、模态弹窗、跳到底部圆钮 |

`glassPane()` / `glassChip()` 现在**一次 `backdrop-filter` 都不输出**，`glassFloat()` 保留（它浮在正文文字上，底下真有东西）。滑杆 `glassBlur` 因此不再影响这些面板 —— 它们没有可调的模糊了。

**视觉差异不是零，但方向是对的。** 对比页 `diag/pane-no-blur.html`（左右两栏同一个糊壁纸）：带 `blur(40px)` 的那边更哑、更灰，因为它把壁纸**再糊一次**，糊度跟壁纸本身不一致；去掉之后面板跟壁纸的糊度一致，读起来更清透。之前那种「哑光」其实是两层模糊叠加的副产品，不是设计。

⚠️ **`saturate(160%)` 也一起没了。** 它跟 `blur` 在同一个 `backdrop-filter` 里，去掉 `blur` 保留 `saturate` 是没用的 —— `saturate` 同样建 backdrop root、同样要快照、同样会闪。想拿回那点饱和度只能加到壁纸层（`html::before` 的 `filter`），但那是**整窗**改色，风险比收益大，所以没加。

⚠️ **这一轮真正贵的是五条断言。** `file cards stay glass in solid mode`、`inline code stays glass in solid mode`、`user bubble is frosted, not just tinted`、`changed-files card becomes a pane`、`history block is frosted` —— 它们测的都是「这里有 `backdrop-filter`」，也就是**把 bug 保护了五轮**。改成 `no backdrop filter on <selector>` 之后，断言测的才是性质（这类表面不许有快照），而不是实现。**改行为时先问一句：这条断言测的是性质还是实现。**

当时给调参卡加了 `blurred` 读数：列出当前**真正在取快照**的元素，按面积从大到小。它和 `flat` 开关配成一对 —— 开关回答「模糊有没有关系」，`blurred` 回答「是哪一块」。这一轮之前只有前一半，所以每次都得靠猜。

**19. 代码块必须自己裁圆角 —— 用 `overflow: clip`，不是 `hidden`，也不是给表头补 `border-radius`。**

宿主的代码块是三层：外壳 `_block_`（四角圆）、表头 `_bannerWrap` + `_banner`（**上两角圆、下两角直**）、代码 `pre`（**上两角直、下两角圆**）。相邻那条边两边都是直角，外侧两边各自圆 —— 这个设计是对的。

问题出在表头是 `position: sticky; top: 0` 的盖子，会跟着滚动往下滑。**滑到最远时它的下沿正好压在外壳的下沿上**（sticky 的极限位移 = 外壳高 − 表头高，那一刻两者底边重合）。而外壳**不裁子元素**，于是表头的深色填充直接铺到外壳圆角的外面：左下右下变成方角，圆角只剩一道弧线。用户原话：「标题框的高度高于文本框剩余高度时，文本框的圆角会被标题框的下直角覆盖」。

顶上是**反过来**的，而且本来就没问题：外壳上两角是直角、表头是圆角，两者半径相同，一叠正好合成一个圆角。

```css
html[data-dshbg-on] [class*="_block_"]:has([data-code-block-banner]),
html[data-dshbg-on] .md-code-block {
  /* …玻璃填充… */
  overflow: clip !important;
}
```

⚠️ **`clip` 和 `hidden` 绝对不能换。** `overflow: hidden` 会建立滚动容器，sticky 的参照物变成它自己（而它不滚动）→ 表头彻底不再粘，代码直接盖到语言标签上。`overflow: clip` **不建滚动容器**，只按圆角裁，sticky 照旧相对转写区滚动。实测 `diag/banner-clip.html`（表头位移 / 极限位移）：

| 外壳 | 表头位移 | sticky | 下两角 |
|---|---|---|---|
| 无（现状） | 72/72 | 生效 | **方角，盖住外壳圆角** |
| `overflow: hidden` | 0/72 | **失效** | 圆角 |
| `overflow: clip` | 72/72 | 生效 | 圆角 |

⚠️ **第一版修错了方向，留个记录。** 我最初给表头补了 `border-top-*-radius: inherit`。那只管**顶部**（而顶部本来就没问题），管不到「表头滑到底」这个真正的现场 —— 用户看了一眼就说「回滚，不对」。**「症状出现在圆角上」不等于「圆角的声明写错了」；先问一句：这个角是被谁盖住的。**

⚠️ **验证时踩的两个坑。** ① 复刻页里 `.scroller` 一开始没写 `position: relative`，`block.offsetTop` 就以 `body` 为参照，算出来的 `scrollTop` 直接把块推出可视区 —— 用 `getBoundingClientRect` 反推内容坐标。② `eval.cjs` 不设设备尺寸，`shot.cjs` 设了，两边量出来的 x 对不上；截图上找边界别靠推算，直接扫像素。

**20. 圆角只能由容器给，子元素一个角都不要自己声明。**

宿主的表头自己写着 `border-top-left-radius` / `border-top-right-radius`（和外壳同一个半径）。**没吸顶时它是对的**：外壳圆角 + 表头圆角半径相同，一叠正好是一个角，看不出是两层。

但表头是 `sticky; top: 0`。块滚到一半、表头吸在视口顶上时，**外壳的圆角已经滚出屏幕，表头的圆角还在** —— 那两个弧挖出两个缺口，缺口里露出的是外壳自己的填充，而外壳此刻在屏幕上就是个方角。用户原话：「文本框什么也不干，在表头的左上右上会出现文本框的直角」。

```
未吸顶：外壳圆角 ┐ + 表头圆角 ┐ → 一个圆角（等价，看不出）
吸顶：  外壳圆角在屏幕外，表头圆角 ┘ → 弧外侧那小块露出外壳的方角填充
```

```css
html[data-dshbg-on] [class*="_block_"]:has([data-code-block-banner]) [class*="_banner"],
html[data-dshbg-on] [class*="_block_"]:has([data-code-block-banner]) [class*="_header_"],
html[data-dshbg-on] .md-code-block [class*="_banner"],
html[data-dshbg-on] .md-code-block [class*="_header_"] {
  border-top-left-radius: 0 !important;
  border-top-right-radius: 0 !important;
}
```

⚠️ **修法是「摘掉」，不是「补上」。** 第一版给表头补 `border-*-radius: inherit` 就是反着来的（见 #19），用户一句「回滚，不对」直接否掉。补半径只会让缺口更明显，摘掉半径缺口才消失 —— **圆角从容器那一个出口出，子元素退化成方的，被裁之后看上去仍然是圆的**。

⚠️ **摘掉之后外观必须逐像素不变，这是这条改动唯一的安全前提。** 未吸顶时两者半径相同，所以裁出来的轮廓一模一样（`diag/banner-corner.cjs`，4 倍放大六种结构）：改前 `y=36` 那一行是 `40,51,61` / `37,48,59` 的描边过渡，改后是 `15,27,39`，**轮廓一致，只是颜色变了**（表头的填充本来就不在，那是外壳的）。如果哪天改完发现「圆角变小了」，说明外壳的半径和表头的半径不再相等，得回去找是谁改的。

⚠️ **断言不能写 `!includes('border-radius')`。** 现在这条规则**主动**把半径写成 `0`，那条否定断言会假绿。改成「扫出所有 `border*radius` 声明，每个非零值都不许存在」（`bannerRuleBodies()` + `bannerRadiusDecls`），再加一条钉住「显式压平了上两角」。

实测对照图：`diag/banner-corner-fix.png`（左/右上角 × 改前/改后四格，60 行代码块滚到表头吸顶）。改前右上角一块方块，改后干净。

**21. 屏幕上那张图必须是「图库 + 选中的 id」算出来的，不能另存一份。**

用户报的现象：往图库里传了几张图，点其中一张想切过去，**壁纸纹丝不动，永远停在新传的那张**。

原因是 `activeImage` 被当成了一个**独立的 state 字段**，而它其实是 `images` + `settings.imageId` 的函数。全项目只有三处给它赋值：`boot()`（按 imageId 反查）、`addImage()`（直接给新图）、`removeImage()`（给 null）。而点图库那一格走的是 `patchSettings({ imageId })` —— **它只改了 id 和 localStorage，没碰 `activeImage`**。`paint()` 读的是 `activeImage`，于是：

| 操作 | `settings.imageId` | `activeImage`（旧） | 屏幕 |
|---|---|---|---|
| 传图 A | A | A | A ✅ |
| 传图 B | B | B | B ✅ |
| **点 A** | **A** | **B** | **B** ❌ |
| 刷新页面 | A | A（boot 重算） | A ✅ |

**「刷新就好了」是这个 bug 的指纹** —— 它说明写进去的数据是对的，只有内存里那份副本没跟上。顺带还有个更狠的：**删掉正在用的那张之后，再点任何一张都不生效，直到刷新**（`removeImage` 把 `activeImage` 置 null，之后再没人给它赋值）。

```js
function activeImageOf(images, settings) {
  if (!Array.isArray(images)) return null;
  const record = images.find((item) => item.id === settings.imageId);
  return record === undefined ? null : record.dataUrl;
}
const derive = (next) => ({ ...next, activeImage: activeImageOf(next.images, next.settings) });
function commit(patch, settingsPatch) { /* …derive… */ }
```

⚠️ **`commit` 必须能同时改 `images` 和 `settings`。** 拆成两次 commit 会画两遍：先「新图库 + 旧选择」，再「新图库 + 新选择」—— 中间那一帧是错的壁纸，肉眼可见地闪一下。

⚠️ **别再把它改回「存一份」。** 这类 bug 的复现条件很窄（必须先有第二张图、再点第一张），正常点一遍设置页看不出来，所以它能活很久。**凡是「B 是 A 的函数」的地方都按这个写：算出来，别存。**

**删掉正在用的那张，不该把壁纸关掉。** v2.49.1 之前 `removeImage` 是「`imageId: null` + `mode: 'none'`」—— 图库里明明还有别的图，删一格就整窗变空白。现在的契约是：

| 删的时候 | 结果 |
|---|---|
| 删的是**正在用**的那张，图库里还有别的 | 选择**滑到顶替它位置的那一格**（删的是最后一格就滑到新的最后一格） |
| 删的是**正在用**的那张，图库空了 | `imageId: null` + `mode: 'none'` —— 真的没东西可显示了 |
| 删的是**没用**的那张 | 什么都不动 |

⚠️ **为什么是「顶替它的那一格」而不是「最新那张」** —— 图库是按上传顺序排的，手指刚点的那一格被删掉后，视线还在原位；跳到最新那张等于替用户做了一次他没想到的选择。

回归测试：`node tools/store-test.cjs`（v2.49.1 时 36 项，现在 78 项）。它**不是**把 store 重写一遍 —— 那样测的是测试本身 —— 而是从 `client.js` 里把 persistence + store 两段切出来，配一个假的 `localStorage` 驱动。

分源参数是 v2.50.0 才有的结构，更早的版本没有 `readRaw` / `flatten` / `LEGACY_SETTINGS_KEY`，脚本会**直接拒绝**而不是跑出一堆假红：

```bash
git show v2.49.1:client.js > /tmp/old.js && node tools/store-test.cjs /tmp/old.js
# missing "const LEGACY_SETTINGS_KEY =" — this revision predates per-background settings
```

**断言不是空跑的，验法是变异**：把 `presetOf` 改成永远返回同一个 preset（等于取消分源），11 项立刻红，每一条都在喊"切过去还是上一个值"。同理，把 `derive` 改回存一份 `settings`，图库那几条会红。

**22. 死代码要靠「数」找，不能靠「看着像」。**

v2.49.0 做了一次减法：`client.js` 3857 → 2941 行（-24%），冒烟测试 266 → 233 项。删掉的东西没有一件是「看起来没人用」——每一件都有一次可复现的计数。

| 删掉的 | 怎么证明它是死的 |
|---|---|
| `state.ready` | 写 3 次、**读 0 次**（`.ready` 在全文里只出现在赋值处） |
| `TEXT.autoSaved` | `text.autoSaved` 零引用（中英各一个键，都没人取） |
| `lastCostReading()` + 设置页那行「费用明细弹窗上次读数」 | 读 `dshbg.cost.probe`，**全仓库没有任何地方写这个键** |
| `flatCss` + `data-dshbg-flat` / `-noblur` 整条管道 | `parseSettings` 里两个 flag 硬编码 `false` → 属性永远不写 → 函数永远返回 `''` |
| marquee 的 `record()` / `trace()` | 只写不读：两个 localStorage 键，全项目没有任何 `getItem` |
| 调参卡（617 行） | 设置页有同样的九条滑杆和三个开关 —— 第二套 UI |
| `settings.menuFill === undefined ? 76 : …` ×8 | `parseSettings` 永远产出完整对象，那半个三元永远不会走。而且三处 fallback 各不相同（76 / 30 / 40），谁也不知道哪个是真的 |

**方法**：写一个脚本，把每个函数名在全文里数一遍（`count === 1` = 只有定义没有调用），把每个 state 字段数一遍（`.field` 出现 0 次 = 没人读），把每个 localStorage 键的 `getItem` / `setItem` 分开数。**这三个计数能抓到的，肉眼一个都抓不到。**

⚠️ **两个反直觉的坑。**

1. **「读 0 次」要用解构赋值验证。** `const { settings, activeImage } = state` 这种写法里，`.activeImage` 的计数是 0，但它明明是活的。计数脚本必须同时数 `.field` 和解构模式，否则会把活的删掉。`state.ready` 是真死，因为它在解构里也一次没出现过。
2. **删掉一个功能，测试会替你数出所有「锁死这个功能」的断言。** 删调参卡红了 5 条，其中 4 条是 `CODE.includes('document.body.appendChild(host)')` 这种**源码文本断言** —— 它们测的不是行为，是「这段实现还在」。这类断言越多，能删的东西越少。

**顺序**：先删**证明得了死**的（A 组），再删**证明得了不可达**的（B 组），最后才动**产品决策**（C 组）。前两组不需要问任何人，第三组需要一句确认 —— 而且删完要能说清「丢了什么、怎么拿回来」（这次是 `git show v2.48.3:client.js`）。

**23. 「没被归类」不会报错，它只是不生效。**

v2.50.0 把设置拆成三张名单：`POINTER_KEYS`（决定是哪张背景）、`PRESENTATION_KEYS`（跟着背景走）、`GLOBAL_KEYS`（全局）。`applySettingsPatch` **只认这三张名单里的键**。

于是加一条新滑杆时如果忘了归类，症状是：滑杆能拖、界面不变、松手后弹回原值。**没有异常，没有日志，没有一处代码看起来是错的** —— 因为值确实被写进了 patch，只是没人接。

判据：**凡是「白名单过滤」的写法，都必须有一条断言钉住「全集 = 各子集之并」**。冒烟测试里那条 `every default is classified into a group` 就是干这个的：它遍历 `DEFAULTS` 的每一个键，任何一个没落进三张名单之一就红。同组的 `no key belongs to two groups` 防的是另一种写法错（同一个键在两张名单里，谁后应用谁赢）。

**24. 两层叠在一起交叉淡化，总不透明度不是 1。**

换壁纸要淡入淡出，而 `background-image` 不是可动画属性 —— 往正在显示的那个元素上写新 URL 是一帧换完的。所以壁纸改成两个盒子：`::before` 放正在显示的那张，`::after` 放正在淡入的那张。

第一版做的是「对称淡化」：两张同时动，一张 1→0，一张 0→1。看起来最自然，也**是错的**：

```
::after 叠在 ::before 上面，合成 = a2 + a1 * (1 - a2)
a1 + a2 = 1 时，中点覆盖率 = 0.5 + 0.5 * 0.5 = 0.75
```

中间那一下整块壁纸只剩 75% 不透明，底下的黑色透上来 —— **淡入淡出中途会暗一档**。

正解是**底层一直保持 `opacity: 1`**，只让上层从 0 淡入：`a2 + 1 * (1 - a2)` 恒等于 1，全程线性。

实测（`diag/fade-static.cjs`，两个盒子都冻在 `opacity: 0.5`，底色灰 100 / 上层灰 200）：

| 模型 | 中心像素 | 理论 |
|---|---|---|
| 底层保持 1（现在这样） | **150** | 150 |
| 两层同时淡出 | **125** | 125 |

⚠️ **别指望截图能抓到动画中途那一帧。** 一次 `Page.captureScreenshot` 的往返比它要抓的那几帧还长，采样点会不断跳过 50% 那一刻 —— 第一版用动画测，采到的是 0.089 → 0.633 → 0.927，中间那个最该看的点从来没落上。**合成规则是个静止的问题，就用静止的方式问它。**

配套的两条约束：

- **只有「换了一张画」才淡。** 拖滑杆不改 `value`，只改 `blur` / `dim`，走的是「同一个 `value`，改写数字」那条路 —— 否则每拖一下壁纸都在自己跟自己淡化。
- **淡完之后要有人把下面那些收掉。** 上面那层淡到 1 之后它就是唯一可见的东西，所以下面全部可以删。由 store 里的一个定时器在 `FADE_MS + 60` 做，那一刻的删除是构造上不可见的。

**25. 正在跑的过渡改不了，只能另起一层。**

连点图库时，第二张还在淡入，第三张就到了。两条捷径都试过，都不行：

| 做法 | 结果 |
|---|---|
| 把上面那层「加速冲到全不透明」 | 改 `transition-duration` 会让进度按 `(now - start) / duration` 重算，一帧从 0.3 跳到 0.95 —— 换成另一种跳变 |
| 把它「退到全透明再换」 | 点击只要比 0.12 秒快，退到一半又被下一次点击重新计时，屏幕停在一档混合色上不动 |
| 让它排队、等这一趟走完 | 不跳，但每次点击都要等满一个淡入，连点 8 次要等一秒多才追上 |

**判据：任何「改时长 / 改目标」都是在动一个已经在动的东西，它一定会跳。** 正解是**根本不去动它**：新图另起一层叠在最上面，从 0 淡入。合成是可结合的 —— `γ·C + (1-γ)·(前面整摞)` —— 前面那摞的覆盖率本来就是 1，所以整摞永远刚好盖满，而最新的那张最终在上面。**没有任何一步需要打断，也就没有任何一步会跳。**

⚠️ **这就是壁纸必须从伪元素换成真实元素的原因。** `html` 只有 `::before` / `::after` 两个，够一次交叉淡化，不够一次连点 —— 层数是随着点击长的，没有上限。现在是一个 `[data-dshbg-stack]` 容器挂在 `body` 上，每张图一个 `[data-dshbg-wall]` 子元素。

⚠️ **盒子必须按 id 认，绝不能按序号认。** 最底下那层被丢掉时，如果盒子是按序号命名的，后面每一个都要改名 —— 而改名意味着重写一个正在屏幕上的盒子的图。`syncWalls` 因此只在两个时刻写盒子：**创建时**和**丢弃时**。

⚠️ **淡入必须是 Web Animation，不能是 CSS `animation` / `transition`。** `paint()` 每次改设置都重写整个 `<style>` 元素，而替换样式表文本会让表里定义的每条动画重启 —— 连点时会把它刚叠上去的盒子全部重置回 0。挂在元素上的动画不受影响。（标题跑马灯是反过来的：它必须留在 CSS 里，因为宿主重渲染会把标题摘下来再挂回去，WAAPI 的动画在那一下会被静默取消。**同一条规律，两个相反结论，判据是「这个元素会不会被摘掉」。**）

⚠️ **丢掉一层本身也是画面上的一次变化。** 一层的可见度 = 它上面所有层的 `Π(1-γ)`，所以「把最老那层丢掉」只有在上面都淡完之后才看不出来 —— 而那要 `FADE_MS`。上限因此是**防卡死指针的护栏，不是调参旋钮**：`MAX_WALLS = 12`，走到那里时最老那层上面压着十来个淡入，乘积在 `1e-11` 量级。**6 层太紧**：半截的整摞上再连点，被丢掉的盒子还有 2–5% 露在外面，逐帧探针实测 3 帧（`uncovered` 0.023 / 0.034 / 0.046），看着就是一下闪。

⚠️ **定时器按 `seq` 重设，不是按「每次 commit 重新计时」。** 旧版写的是「只许把截止时间提前」，看似防住了连点，实际把队列的消费一起冻住了。现在每次叠新层 `seq` 才变，所以连点确实会把截止时间往后推 —— 但只推一个淡入，因为最后那次点击本来就该拿到完整的 0.6 秒。

⚠️ **最底下那个盒子必须恒为全不透明 —— 它是整摞的地板。** 它有两种被抓到半透明的方式：① 塌成一张之后的幸存者；② 护栏把下面那层挤掉之后的新底层（它可能是以「第二层」身份建的，正淡到一半）。第二种漏掉过，逐帧实测整摞会漏出 0.7% 的桌面。所以 `syncWalls` 里那条钉死判断是 `index === 0`，不是 `walls.length === 1 && index === 0`。

⚠️ **`burst-replica.html` 的绿灯必须能变红。** `make-burst-replica.cjs --break` 会把旧 bug（新图直接写到已经在屏幕上的那个盒子上）注回去，同一检测器必须报红 —— 实测 18 处。检测器逐帧比对三件事：① 已在屏幕上的盒子图变了没有；② 盒子被移除时，上面那些层是不是已经把它完全盖住；③ 整摞最底下那层是不是全不透明（覆盖率必须恒为 1）。实测 275 帧、0 违规。

⚠️ **点击脚本必须包含一段「在半截的整摞上再密集点」** —— 前六次点击间距 80ms，等它落定，再在 3000ms 处来八次 60ms 的密集点击。只测从头开始的连点，护栏那条路径永远走不到（第 7 次点击之前整摞早就塌回一张了），而那正是唯一会「丢掉一个还看得见的盒子」的时刻。

⚠️ **复刻页的点击脚本每一条都要写全 `mode`。** 只给 `imageId` 而 `mode` 还停在 `color` 上，`backgroundValue` 返回的是那个颜色，一串点击等于什么都没做 —— 页面照跑、帧照采、结论照出，全是空转。同理要先 `localStorage.clear()`：浏览器配置是复用的，上一轮留下的文档决定这一轮从哪张开始。

⚠️ **顶层脚本跑的时候还没有 `<body>`。** 解析器那时还在 `<head>` 里，`document.body` 是 `null`。复刻页因此先挂到 `documentElement` 上，等 body 出现再挪过去；插件里没这个问题（`installStyles` 在 effect 里跑）。

**26. 一张图有三种存法，因为它们的像素存在方式不一样。**

| 类型 | 存 | 放 |
|---|---|---|
| 静图 | 缩到 2560px 压成 JPEG，data URL | `background-image` |
| 动图（GIF / 动态 WebP / APNG） | **原始字节**，一个字节都不动 | `background-image` 指向 blob URL |
| 视频（MP4 / WebM） | **原始字节** | 盒子里放一个静音循环的 `<video>` |

**动图不能过 canvas。** `drawImage` 一张 GIF 再 `toDataURL` 出来只剩第一帧 —— 这是「支持动图」最容易踩的坑：代码看起来在压缩，实际上在把动图变成静图。所以动图和视频都按原样存进 IndexedDB（浏览器原生支持结构化克隆 Blob），代价是不再受「缩到 2560px」保护，因此单独设了 `MAX_MEDIA_BYTES = 96MB` 的单文件上限。

⚠️ **`<video>` 要四个属性一起才算壁纸**：`muted` / `loop` / `autoplay` / `playsinline`。少一个 `muted` 浏览器直接拒绝自动播放；少一个 `playsinline` 移动端会想全屏播。**而且 `muted` 必须同时写属性** —— 这个 IDL 属性不反射到内容属性上，自动播放策略读的是元素解析时的静音状态，只写 `.muted = true` 在真机上会静默变成「不播」。

⚠️ **视频的封面帧是抽出来的，不是截出来的。** `ingestVideo` 用 `loadeddata` 等第一帧可用，画进 canvas 得到一张 1280px 的 JPEG。这一帧同时用在三处：图库缩略图、设置页预览、**亮度测量**。亮度只读封面意味着插件的自动反色从来不碰视频本体 —— 否则拖一下压暗滑杆就要解一次视频。

**「减少动态效果」开着时，动图和视频都只显示封面。** 不是「动得快一点」，是根本不动。

**取景位置（`focusX` / `focusY`，0–100）同时落到 `background-position` 和 `object-position` 上。** 两个都得写，否则同一张照片和同一段视频会按两套不同的构图显示 —— 而用户调的是「这个人要在画面里」，跟它是图还是视频无关。

⚠️ **重写同一个 `background-image` 字符串会让动图从头开始。** `paint()` 每次改设置都跑一遍，拖模糊滑杆就是每帧一次；所以 `paintWall` 先比较再写，值没变就不碰。静图写同一串是无害的，动图不是。

**拖动映射是一对一的，不是固定灵敏度。** `cover` 把图放大到刚好盖住盒子，能走的距离就是 `scaled - box`，拖动正好这段距离就该走满 100%。方向要取反：`X%` 是「图的 X% 对齐盒子的 X%」，X 变大等于把图往左推。某个方向没有余量（竖图放进横窗口的上下方向）就拖不动 —— 这是事实，不是坏了。

⚠️ **取景位置是分源参数，但上传新图不继承它。** 这条是第 23 节那张表的唯一例外，理由不是「重不重要」，是问题本身不一样：模糊回答的是「这个界面长什么样」，偏移回答的是「这张图怎么裁」。继承一个 12% 的横移，等于把新图塞进它从来没有过的构图里。

⚠️ **WebP 判断不了「动不动」。** 没有便宜的 API 能在不解码的情况下数帧，所以 `image/webp` 一律按动图处理、原样存字节。静态 WebP 因此不享受缩图，会比预期的大一些 —— 这个取舍写在 README 的「已知边界」里。

`diag/make-media-replica.cjs` 用 ffmpeg 造的三份真素材（png / 动画 gif / mp4）跑真实的 ingest 与 `paintWall`，回答的是桩子答不了的问题：封面解出来是不是一张真图、`<video>` 到底有没有在播。**注意它需要能起浏览器的环境**（`CDP_PORT` 那台无头 Chrome）；沙箱拦掉图形进程时它会直接失败，那时不要把它当成「代码有问题」。

**27. 设置弹窗的底是两层，滑杆上那个数不是屏幕上的数。**

宿主设置弹窗的结构（从 `app.asar` 的 JSX 抄，不要凭印象）：

```
div.AnXs9G_overlay[role=presentation]        position: fixed; inset: 0
  div.AnXs9G_mask[aria-hidden]               background: --dsw-alias-bg-mask-1   ← 50% 黑
  div.AnXs9G_panel[role=dialog][aria-modal]  background: --dsw-alias-bg-layer-2
```

`dialogCss` 一直命中了 `.AnXs9G_panel`（它有 `role="dialog"` + `aria-modal`），但它给的 46% 填充是**和遮罩叠着算的**：`1 - .54 x .50 = 73%` 不透明，壁纸只剩 27%。深色壁纸上 27% 等于没有，所以这个页面看起来从来没有被适配过 —— 而代码里每一行看起来都是对的。

⚠️ **这就是侧栏那条 `1-(1-a)²` 的同一个形状**：一个区域被两层各自「一半」地画，屏幕上的结果永远比任何一层都黑。判据是**问一句「这块底下还有谁在画」**，而不是继续调那一层的数字。

现在的分工：遮罩降到 20%（只负责「让背后退后」，不负责「盖住」），面板 36% 起、跟随「菜单填充」滑杆。冒烟测试里有一条算的是**合成值**（`composite <= 0.6`），不是任何单层 —— 以后谁把任一层调回去，它会红，而不是等用户再截一张黑板。

⚠️ **弹窗里的卡片不能按全局密度重混。** `--dsw-alias-settings-card-fill`（#2c2c2e）和 `--dsw-alias-bg-module-platform`（#353638）是**不透明中性色**，它们的语义就是「这个控件浮在面板上面」。压到六十几的百分比再叠在半透明面板上，合成回 ~91% —— 面板成了玻璃、卡片还是塑料，而且比面板还黑。改成**标签色的纱**（`--dshbg-raw-label-0` 9–17%）：白纱在任何壁纸上都比底下亮，而半透明中性色在亮壁纸上会变成最暗的那块，**没有 alpha 能修正极性**。`--dsw-specific-sidebar-nav-item-active`（#43454a，设置弹窗左侧导航的选中项）是同一个病，一起换。

**28. 子元素不许再画一遍底 —— `/ 1` 会把重混吞掉。**

设置弹窗里「费用」页是黑板、「桌宠配置」页是玻璃，同一个弹窗、同一套配方。差在**内容列上还盖着别人画的一块板**。

`dsh-cost-meter` 的 section 规则是：

```css
.cm-section, .cm-stat-dialog, .cm-qguide, .cm-peak-alert, .cm-footer-stack.simple {
  background: rgb(from var(--dsw-alias-bg-layer-2, …) r g b / 1);
}
```

⚠️ **`rgb(from X r g b / 1)` 把 alpha 写死成 1。** 重混把 `--dsw-alias-bg-layer-2` 换成 `color-mix(…#2c2c2e 50%, transparent)` 之后，这个颜色**自己的** alpha 是 0.5，但 `rgb(from … r g b / 1)` 只取它的 r/g/b，alpha 用自己的 1 —— 重混在到达屏幕前就被丢掉了。所以「token 在重混表里」**不等于**「这个表面会透」。

后果是同一个矩形被画两遍：导航列只有弹窗那层（49%），内容列在它上面又叠了一块（surface 50 时合成 ~75%）。壁纸在面板正中间断成一条竖线，而每一行代码看着都对。

**判据：一块区域是不是「比旁边暗一截、而且完全不带渐变」，先问它上面还有谁在画。** 桌宠那页没有这块板，所以同一个弹窗那页就是玻璃的 —— 这就是对照实验，不用去猜。

修法不是「把第二层调薄」，是**让它透明**：`.cm-section` 是已经填过底的弹窗的子元素，它一个像素的底色都不该有。断言写的是「它是 `transparent`」和「任何 `color-mix` 都不许再回到它身上」—— 前者测性质，后者是那条否定断言的正确形态（扫规则体，不是找某个字符串）。

**29. 原生 `<select>` 的下拉列表画在文档之外，它读不到底下是什么。**

症状是一块**灰色**的列表：`(127, 127, 128)`，黑字，选中行是浅蓝。看起来像「没被主题覆盖」，其实是两条规则在别处合成了：

1. **列表的背板**跟页面的 `color-scheme` 走，宿主留在 light —— 所以它画在**白底**上。
2. **列表的填充**取的是 `<select>` 自己的 `background-color`。宿主的 `.iy1EbG_field select` 写的是 `background: var(--dsw-alias-bg-base)`，本插件把这个 token 重混成半透明的 `color-mix` —— 于是「55% 的 #151517」被送到弹层，压在白背板上。

`0.55×21 + 0.45×255 = 126`，`B` 通道 `0.55×23 + 0.45×255 = 127` → `(126,126,127)`，实测 `(127,127,128)`。**到个位数都对得上**，所以不用怀疑别的地方。

⚠️ **判据：一块画在文档层叠上下文之外的表面，永远不能是半透明的。** 它拿不到「底下是什么」，半透明只会退回它自己的默认背板。同一个道理适用于 `<option>`、`::backdrop`、以及任何由浏览器/系统单独绘制的弹层。

修法只有一条路：**让它不透明，并把控件切进暗色**。

```css
select { color-scheme: dark !important; }          /* 背板、滚动条、悬停高亮一起变暗 */
select option, select optgroup {
  background-color: var(--dshbg-raw-l2, #2c2c2e) !important;   /* 不透明，不是 color-mix */
  color: var(--dshbg-raw-label-0, #f9fafb) !important;
}
```

⚠️ 这里**不能**写 `color-mix(… transparent)`，哪怕比例是 100% —— 断言直接禁止 `transparent` 和 `color-mix` 出现在这条规则里。它测的是性质（不透明），不是某个具体色值。

做不到的部分要说清楚：这个列表**没有壁纸、没有模糊**。它是独立 widget，不是 DOM。

## 九、改了代码之后

```bash
node tools/smoke-test.cjs     # 样式表：284 项
node tools/store-test.cjs     # 状态层：78 项
```

284 项检查，覆盖：模块契约、样式表注入、**壁纸的叠层结构（容器 + 每张图一个盒子；稳态只有一个盒子；淡入挂元素而不是样式表；压暗走 brightness 而不是黑层；关掉壁纸连容器一起收走）**、token 捕获与重混、**作用范围（左栏是否被重混）**、对话区与输入框独立不透明度、标题栏通栏、标题栏按钮探针、设置页及其作用域、**分源参数的三张名单（全集 = 各子集之并、无重叠、玻璃模糊留在全局）与设置页那句「滑杆属于当前这张背景」**、液态玻璃五档归属与四套配方（面板 / 芯片 / 悬浮控件 / 深色玻璃）、底部状态栏、头部胶囊、用户气泡、费用明细胶囊与头部那颗的隐藏、回到最下面圆钮、侧栏历史块（随内容收缩、行一条规则都没有、三处边缘对齐、关掉宿主 `_fade`、**和计费器共用同一个 `paneFill()`**）、计费器宽度与 Windows 下的按钮内缩、悬停预览卡的玻璃与 50% 填充下限（外加「别再钉回不透明」）、菜单的玻璃画在表面而非材料层、材料层让位、**输入框的玻璃画在卡片自己身上、菜单开着时由 `installComposerMenuGuard` 让出模糊、浓度走 `composerSurface`**（伪元素那条路试过两次，填充上屏、模糊从未上屏）、右侧侧边栏的玻璃（**只在打开时**）与下层停止画底色、悬停卡的填充下限、**菜单模糊能一路进到样式表、上限 320**、**侧栏自己的浓度档与「列不再重复画底」**、**弹窗打开时背后几乎不压暗（0.95，不是 0.52）**、**费用明细弹窗的玻璃由打过补丁的它自己负责，本插件不再插手**、悬停卡与 tooltip 的深色玻璃（描边不用 border）、团队面板（portal 与内层 token 重混）、代码块三处底色与标题栏、**没有表头的代码块（.md-code-block 兜底）**、**表头壳是盖子不是窗口（借对话框的 composerSurface + menuBlur，断言比对的是「两处相等」而不是某个常数）**、**代码块的模糊挂在 `pre` 上而不是块上（块带 backdrop-filter 会让表头采不到 `pre`）**、**弹窗打开时 `#root` 只压暗不模糊、`::backdrop` 只压暗不磨（两条否定断言，滑杆够不到的整窗 filter 一律不许有）**、**配方里一次真 `border` 都不许有、面板的环必须是 inset 阴影（真 border 在 content-box 上撑宽 2px，2px 就够起一条横向滚动条）**、**诊断开关和它的管道都不在了**、标题的「放得下就不滚」与 `max-width` 还原时机、选择器 / 测量方式 / 无缝循环 / 自激防护 / 声明式动效与关键帧、配置页实际渲染、五种字体模式、cost-meter 兼容层、**壁纸层的盒子走 vw/vh 而不是 inset（滚动条进出它不动）、且带 will-change: filter**、**「底下只有糊过的壁纸」的表面一律不许有 backdrop-filter（六个选择器逐个查规则体）、侧栏 pane 同样不许**、**代码块用 overflow: clip 自己裁圆角（不是 hidden，那会杀掉 sticky 表头）**、**表头一个角都不许自己声明（扫出所有 border*radius 声明，非零值一个都不许有，且显式压平上两角）**、**动图与视频三种来源各自的落地方式（照片写 data URL；动图写 blob URL 而不是封面，否则「动图」只显示第一帧；视频在盒子里放一个真的 `<video>`，封面先写在 `background-image` 上兜底）**、**`<video>` 的四个属性一起才算壁纸（muted / loop / autoplay / playsinline），且 `muted` 必须同时写属性 —— 这个 IDL 属性不反射，自动播放策略读的是元素解析时的静音状态**、**减少动态效果时一律退回封面（不是「动得快一点」，是根本不动）**、**取景位置同时落到 `background-position` 和 `object-position`（同一张图和同一段视频不能按两套构图显示）**、**底部状态栏是唯一保留真 backdrop-filter 的 pane，且它的模糊值必须和输入框卡片一起随 `menuBlur` 变化（不是两处各写一个数）**、**设置弹窗的合成不透明度（面板 + 它自带的那层遮罩算的是屏幕上的值，不是任何单层）与弹窗内卡片改用标签纱而不是重混中性色**、**费用分区的 section 自己不许有底色（它是弹窗的子元素，弹窗已经画过一遍；`rgb(from … / 1)` 会把重混吞掉）**、**原生 `<select>` 下拉列表的底色必须不透明（它画在文档之外，读不到底下是什么；半透明会退回弹层自己的白背板）且控件切进暗色**、**插件市场的全屏页自己画一层 45% 的底，而不是用它自带的 `layer-1`（`layer-1` 的语义是「比 pane 高一层」，带 +8 的 lift；它不是面板，它就是页面），且浓度必须 ≥ 40 —— 这页的正文是 12px 小字直接坐在页面上，22% 那种「只负责给转录区上色」的浓度在这里就是读不清**、**市场卡片是标签纱不是重混中性色（底下是糊过的壁纸，加 blur 看不出区别；让它从塑料变玻璃的是填充）**、**市场吸顶栏必须真遮住滚过去的内容（它底下是文字不是壁纸，所以它跟底部状态栏一样拿同一份填充 + `menuBlur`）**、**而且它必须是「一个盒子」：宿主那条 14px 的 `::before` 要摘掉而不是补模糊（补了就是两个各自模糊、各自加填充的层，交界处是硬台阶），盒子再往上拉 `padding-top` 那么多把滚动容器的 8px 内边距盖住 —— 否则它上面留一条「只有页面填充」的带子，密度差一截，屏幕上就是一道缝**、**吸顶栏下面要有填充出来的空隙（padding 不是 margin，margin 留的是能看见卡片滚过去的洞）**、生命周期、CSS 语法与选择器前缀。

78 项状态层检查，覆盖：持久化与迁移（v4 / 退回 v3 / 每个源各自一套滑杆）、分源参数的三张名单（全集 = 各子集之并、无重叠、玻璃模糊留在全局）、删图规则，以及**壁纸的叠层模型** —— 第一张单独上屏、换图留下旧图、新图叠在上面、滑杆只落在顶层、下面那层保留自己的模糊、淡完只剩一张、下一次叠在幸存者上、重选顶层不加层、关掉清空、重开一张不淡；再加两组连点（3 层 / 5 层 / 护栏丢最老 / 塌成最后点的那张 / 十连点不饿死 / 落到最后一次点击）；再加一组**取景位置**（一张图从居中开始、拖动只改这一张不叠层、偏移写在这张图名下、换一张图用自己的偏移、换回来能恢复），以及**上传不继承偏移**（模糊继承、取景不继承 —— 前者是「界面长什么样」，后者是「这张图怎么裁」）；最后是**上传分流**（png 走照片、gif / webp / apng 走原始字节、mp4 / webm 走视频、超 96 MB 在解码前就拒绝、照片不受这个上限约束）—— 走错分支不会报错，只会让动图不动。

### 调参卡：已经删掉了（v2.49.0）

它曾经是这张插件上最大的一块代码：一个挂在 `document.body` 上的浮层，九条滑杆 + 三个开关 + 一块只读探针，为的是「在真壁纸上调数字」——设置页是整页视图，在那一页拖滑杆看不见输入框和菜单。

**为什么删**：设置页早就有同样的九条滑杆和三个开关，那张卡是第二套 UI；而它服务的两件事都已经结束——闪烁在 v2.47.0 定位到面板的 backdrop 快照并修完，菜单玻璃的两个数字也定稿了。留下的只有 600 行重复代码和一块默认开着的浮层。

**删掉之后丢了什么**：`frame`（帧时间 / 掉帧数）、`blurred`（谁在取 backdrop 快照）、`overflow`（谁比自己盒子宽）、`raw` / `mixed`（token 捕获与重混的值）。这些都是**「数字太小」和「数字根本没进 CSS」**的区分手段，第八节 #14–#18 里每一轮排查都靠它。

**要拿回来**：`git show v2.48.3:client.js`，那一版里整块在 `// ---- tuning dock` 和 `// ---- registration` 之间，独立于其它任何代码，原样贴回来就能跑（记得同时恢复 `showDock` 和 `TEXT.dockTitle|dockGlass|dockFullWindow|dockPreset`）。

**设置页那行诊断还在**：`样式 / 激活 / 框架 / 三栏` 四项仍然能区分四类故障——样式表没注入、`<html>` 没标记、框架没定位到、栏数不对。这是当初最救命的那个读数，它不在被删的那块里。

`--dump` 可打印实际产出的 CSS：

```bash
node tools/smoke-test.cjs --dump
```

跑通后直接看真机效果就行 —— 这个环境会热更新，**不用退出 DSH 重开**。插件页底部的 `样式 / 激活 / 框架 / 三栏` 四项能区分四类故障：样式表没注入、`<html>` 没标记、框架没定位到、栏数不对。

## 十、已知边界

- 作用范围靠结构定位（`nth-of-type` + `data-shell-*`），宿主大改布局会失效；失效时插件页会显示提示，且不影响其他界面。
- 只改工作区时标题栏整条是侧栏色。想让壁纸顶到窗口最上沿，就把作用范围切成整窗。
- 标题栏按钮的适配依赖 preload 里那个探针的 `style` 属性原文（用 `[style*="--dsw-specific-sidebar-fill"]` 匹配）。如果哪天 DSH 改成给探针加 class 或用别的变量，这条规则会静默失效——表现为按钮退回实色块，其他一切照常。整窗模式下符号色取的是整张壁纸的平均明暗，不看右上角局部，所以角落特别亮/特别暗时对比度可能不理想。
- 只处理插件管理器页面保持不透明；DSH 通用设置页未做处理。
- `costMeterCss` 依赖 `dsh-cost-meter` 的类名，对方改类名后该规则静默失效（不报错，只是卡片变回实色）。
- **视频壁纸一直在解码**，比静图费电；没有做「窗口失焦就暂停」。真要省电再加，但那会引入「切回来时从哪一帧继续」的问题。
- **`image/webp` 一律按动图处理**（判断不了动不动），静态 WebP 因此不享受 2560px 缩图。
- 动图 / 视频的上限是单文件 96 MB；超过直接拒绝，不做转码。没有做「同目录批量导入」。
- **抽封面依赖 `loadeddata` 能在解码器里拿到第一帧。** 编码不被支持的视频（某些 HEVC、某些带 DRM 的文件）会在这一步失败，设置页会提示「这个视频播不出来」。MP4/H.264 与 WebM/VP9 实测可用。


## 附录 A · 各表面的注释原文

v1.0.1 精简代码时，从 `client.js` 里搬出来的长注释。代码里只留了「不许做什么」和一句指路，推导过程、实测数字、走过的弯路都在这里 —— **一个字的都没删，只是换了个位置。**

### A.1 `transcriptGlassCss`

/**
 * Glass inside the transcript - file cards and code blocks. Always on.
 *
 * These are content, not chrome: they sit in the middle of the work area on top of the
 * wallpaper, and a flat opaque block there reads as a hole punched in the artwork. So
 * they do not follow the composer switch - turning the message box back to solid is a
 * statement about the box, not about every code block in the transcript.
 *
 * Three shapes, three hooks, none of them a hashed class guess:
 *
 * - Code blocks expose `[data-code-block-banner]`. Their wrapper class is
 *   `_block_<hash>_<line>` and the banner lives two levels down
 *   (`_bannerWrap` > `_banner[data-code-block-banner]`), so the wrapper is found with
 *   `[class*="_block_"]:has([data-code-block-banner])` - the `_block_` prefix survives a
 *   rebuild, the hash does not. Note the host also puts a plain `md-code-block` class on
 *   that same div, which is the one non-hashed hook in the whole transcript, but it only
 *   carries a margin, so the hashed prefix is still what has to be matched.
 *
 *   **The banner is not always there.** When it is missing - a fenced block with no
 *   language, a block still streaming in, the trajectory/preview renderers - the
 *   `:has()` half fails and that block keeps painting nothing at all, which shows the
 *   wallpaper through the code as a bare gradient. So `.md-code-block` is matched
 *   directly as a second alternative: it is on every one of these wrappers, banner or
 *   not, and it is stable across rebuilds.
 *
 *   Three things paint the block's colour, and clearing two of them is what left the
 *   header bar solid: `_block` paints `var(--dsl-code-block-background)`, `pre` paints
 *   the same variable (with `!important` for shiki), and `_banner` paints
 *   `var(--dsl-code-block-banner-background-color)` - a *different* token that an
 *   earlier version never touched, because it only cleared `_bannerWrap`. Clearing the
 *   two custom properties on the wrapper handles all three at once, since both are
 *   inherited and every one of those rules reads them through `var()`. The explicit
 *   transparent rules stay as a belt-and-braces for `pre` and the `_banner` row, which
 *   paint their own backgrounds.
 *
 *   **`_bannerWrap` is the exception, and it is the opposite of everything above.** The
 *   host makes it `position: sticky; top: 0; z-index: 6` and paints it with
 *   `var(--dsw-alias-bg-base)` - it is a *lid* for the code scrolling underneath, not a
 *   surface on wallpaper. Clearing it (which every version up to 2.44.0 did) turned the
 *   lid into a window: two lines of code ended up overlapping the language label and the
 *   copy button, which reads as "the sticky is broken". It now takes the composer's
 *   material instead - see `bannerFill` / `bannerBlur` at the top of this function.
 *
 *   Note the near-miss: `[class*="_banner"]` matches `_bannerWrap` **and** `_banner`, so
 *   a rule written for the row silently hits the lid too. The two need separate rules,
 *   in this order.
 * - Attachment chips are `cJsG2q_fileCard` - hash first, then the local name, so
 *   `[class*="_fileCard"]` is the stable half.
 * - Deliverable cards are `flL80G_file`, and they paint `var(--deliverable-fill)` - a
 *   *static neutral*, not one of the semantic tokens, which is why the token remix
 *   never reached them. The card also carries `data-presented-file`, which is the
 *   primary hook; `_file` alone would also catch the 24px composer chip and the
 *   changed-files row, so the class fallback requires the card's own `_fileBody` child.
 *   Both halves of that fallback are local names, so a rebuild does not move them.
 * - Inline code is `._markdown_<hash>_<line> :not(pre)>code`, painting
 *   `--dsw-alias-markdown-inline-code`. `_markdown_` is the stable half - note the
 *   trailing underscore, which keeps it away from `_markdownPreview`. The `:not(pre)`
 *   half is the host's own guard: it is what separates inline code from block code,
 *   and reproducing it means a block-level `pre` is never turned into a chip.
 */

### A.2 `installTitleMarquee`

/**
 * Drives the session-title marquee.
 *
 * Pure CSS cannot do this: the distance to scroll is "however much is hidden", and no
 * length unit expresses that. So the distance is measured here and handed to a Web
 * Animation.
 *
 * Measurement uses a `Range` over the title's contents instead of `scrollWidth`. The
 * range reports the text's own width - the thing that actually has to travel - and it
 * stays correct while an animation is running. `scrollWidth` is read off the content
 * edge that `text-indent` is moving, so a live animation makes every re-measure read
 * its own output.
 *
 * The box is pinned with `min-width` while the animation runs. An inline-block is
 * shrink-to-fit, and `text-indent` contributes to the first line's max-content width,
 * so pulling the text left also narrows the box - which re-fires the ResizeObserver and
 * restarts the very animation that caused it. Pinning removes that feedback path. The
 * pin is cleared before every measure so a real resize still lands.
 *
 * Travel is one-directional and continuous: the title slides left at a constant speed
 * and the loop point lands on a frame identical to the one it started from. Two pieces
 * make that seamless. A `::after` repeats the text (its content comes from the
 * `data-dshbg-mq` attribute, so no DOM surgery on a React-owned node), and the animation
 * travels exactly `text width + MARQUEE_GAP` - the distance from "first copy starts at
 * the left edge" to "second copy starts at the left edge". Anything shorter shows a
 * blank box for part of every cycle; anything longer stutters at the seam.
 *
 * The distance was previously driven by the *overflow* and the motion was a there-and-back
 * pass on a fixed formula, "7s + 60ms/px". A title 22px too long got the same 8s pass as
 * one 200px too long: 2.6px/s, which reads as a title that does not move at all. Speed is
 * now a constant, so the overflow only decides whether it scrolls, not how long it takes.
 *
 * Re-measuring is driven by the title's own signals - a ResizeObserver on the crumbs nav
 * plus a MutationObserver filtered to the crumbs - not by a global observer. The
 * transcript mutates on every streamed token, and a global observer would restart the
 * marquee dozens of times a second. A few timed re-syncs after boot cover the case where
 * the header has not been laid out yet when the plugin starts.
 *
 * The motion itself is a **CSS animation**, not a Web Animation. That is deliberate: a
 * WAAPI animation is a JS-owned object, so anything that re-runs `sync()` can cancel or
 * replace it - and the host re-renders the header, which detaches and re-attaches the
 * title and silently kills whatever animation was attached to it. Declarative CSS is
 * re-applied by the style engine whenever the element comes back, so the scroll survives
 * every re-render. JS only writes three things: the `data-dshbg-mq` attribute that turns
 * the animation on, and the `--dshbg-mq-loop` / `--dshbg-mq-dur` custom properties that
 * set its distance and duration. Those are written only when they actually change,
 * because re-writing a custom property restarts the animation from zero.
 *
 * Everything is dropped when the wallpaper is off, because the matching
 * `text-overflow: clip` lives in the activation-scoped stylesheet. Left running without
 * it, a scrolling title would still pin its ellipsis to the right edge.
 */

### A.3 `chromeCss`

/**
 * Window chrome.
 *
 * The layout paints the drag strip as a `::before` over the frame's top padding, filled
 * with the sidebar colour. That strip is window chrome, not work area, so in work-area
 * scope it is left exactly as the layout paints it: one solid slice of the sidebar fill
 * across the full width.
 *
 * It used to be cleared and replaced with a gradient that ended at
 * `--dsh-windows-sidebar-width`, so the wallpaper continued above the work area while
 * the sidebar kept its own fill. That only holds while the sidebar is open. The layout
 * publishes the sidebar *track* width, and the track collapses to `0px` the moment the
 * sidebar closes - so the gradient's stop landed at zero and the entire strip turned
 * back into the full-width band of wallpaper it was introduced to remove. Closing the
 * sidebar reproduced the original complaint exactly.
 *
 * The band was already wrong in a second, quieter way: over a page that forces itself
 * opaque - the settings page does - a wallpaper strip sits directly on top of a dark
 * sheet, so it reads as a bright bar even with the sidebar open.
 *
 * Whole-window scope is the one case where the strip has to clear: there the chrome is
 * glass like everything else, and the wallpaper is meant to run behind the whole window.
 *
 * Both markers live on <html>, so they share one compound selector; a descendant
 * combinator between them never matches.
 *
 * **The sidebar column also stops painting in whole-window scope.** The host fills that
 * column with `--dsw-specific-sidebar-fill` *and* its inner root fills itself with the
 * same token, so a declared 40% lands as `1-(1-0.4)²` = 64% - the column is always
 * darker than the panels beside it, which is the "left sidebar is black" report. Letting
 * **The top strip: tint, not frost.** The strip sits *above* the columns rather than
 * inside one, so it has to fake the surface that continues below it. Two things went
 * wrong when it tried:
 *
 * - leaving it transparent made it brighter than the frosted columns (a band);
 * - giving it a `backdrop-filter` made it *sharper or blurrier* than the columns, whose
 *   glass is a token remix - colour only, no blur. Blur cannot match a surface that has
 *   none, so the strip still stood out.
 *
 * So it only carries the same colour: a hard-stop gradient that uses the sidebar density
 * over the sidebar column and the conversation density over the work area, sampled at
 * `--dsh-windows-sidebar-width`. With the sidebar collapsed that variable is 0px and the
 * whole strip correctly takes the work-area colour. If the variable is missing the
 * gradient is invalid, the rule drops out, and the strip falls back to the theme colour -
 * a quiet failure rather than a bright bar.
 */

### A.4 `historyBlockCss`

/**
 * The block behind the sidebar's history list.
 *
 * It is sized by its content, not by the column: `flex: 0 1 auto` on the wrapper and
 * `flex: 0 1 auto` on the scroller inside it, so the block grows one row per session
 * and stops at the bottom of the column when the list gets long. The host's own
 * `flex: 1` on both would stretch the block to the full remaining height, which leaves
 * a large empty pane under a short list.
 *
 * The inner scroller has to have its flex-basis put back to `auto` as well. `flex: 1`
 * is `1 1 0%`, and a `0%` basis inside an auto-height parent resolves to zero height -
 * the block would collapse to its padding.
 *
 * Width: the block lines up with the new-session button above it and the cost meter
 * below it. Those three were all different widths. The button sits at `margin: 0 2px`
 * inside the sidebar's 12px padding; the list area's box is *wider* than the sidebar's
 * content box, because the host cancels `_root`'s 12px right padding with a negative
 * margin so the scrollbar can hug the window edge; and the meter takes the full content
 * box. So the left inset is the button's 2px, and the right inset is that same 2px plus
 * the edge inset the list area just cancelled - measured, not guessed: 2px alone leaves
 * the block exactly 12px wider than the button on the right.
 *
 * The vertical padding is not decoration: `_list` clips its content to a rectangle, so
 * a row painted at the block's edge would show its own square corner through the
 * rounded one, and a hovered row is exactly when that is visible. 6px is past the point
 * where an 8px corner still has curvature left (at y=6 the arc is 0.25px in).
 *
 * The host's `_fade` is switched off here. It is a 24px gradient pinned to the bottom of
 * `_treeBody`, which in the host's layout is the bottom of the whole column - far away
 * from the last row. Once the block shrink-wraps, that gradient lands on top of the last
 * session and dims it for no reason. The block's own edge is the boundary instead.
 *
 * **The fill is `paneFill()`, the same expression the cost meter and the new-session
 * button use.** It used to be 52% of `--dshbg-raw-l1`, which is a different token at
 * more than twice the ratio - so the block read as a dark slab with a light meter
 * directly underneath it, which is what the user flagged. Sharing the expression is the
 * only version of "same blackness" that cannot drift on the next edit.
 *
 * The ring stays an *inset shadow* rather than a `border`. That is not taste: the host
 * does not put `box-sizing: border-box` on these sidebar boxes (its rows are
 * content-box), so a real 1px border would grow the block by 2px in each axis and the
 * right edge would stop lining up with the new-session button. An inset ring draws
 * inside the box and costs no layout.
 */

### A.5 `menuSurfaceCss`

/**
 * Menus.
 *
 * **The blur was never working, and the reason was upstream.**
 *
 * The primitive puts a `[data-menu-material]` surface on the menu, with a
 * `[class*="_material"]` layer inside it that draws `--dsw-menu-surface-fill`
 * (`rgba(67, 69, 74, .45)` in the dark theme) plus
 * `backdrop-filter: var(--dsw-menu-backdrop-filter)` = `blur(40px) saturate(150%)`.
 *
 * `backdrop-filter` creates a *backdrop root*, and a descendant that also has one may
 * only sample what has been painted **inside** that root. The `/` command menu is a
 * descendant of `[data-composer-card]`, which used to get `glassPane`'s blur - so the
 * card was a backdrop root, and the menu hangs at `bottom: calc(100% + 4px)`,
 * *entirely outside the card*. Its sample area was empty. The menu has been behaving
 * like a flat 45% plate all along, which is why the transcript read straight through
 * it; no fill ratio can compensate for a blur that is not there. That is what the 76%
 * was patching over. See `composerGlassCss` for the fix - the card gives its
 * backdrop-filter up.
 *
 * Note what is *not* the cause: the surface's own `isolation: isolate` looked like the
 * culprit, but a control page with the same structure blurs fine, so Chromium does not
 * treat it as a backdrop root here. The ancestor's backdrop-filter is the whole story.
 *
 * The glass is still painted on the **surface** rather than on the material child, for
 * two mundane reasons: the material layer is `z-index: -1`, so any background the host
 * puts on the surface would cover it, and one layer doing fill + blur is one
 * compositing layer instead of two. The material layer is stood down to
 * `background: transparent` / `backdrop-filter: none` so nothing double-paints.
 *
 * **The `/` command menu** also carries no background and no backdrop-filter of its
 * own - its rule is `max-height:400px; box-shadow; padding:4px; position:absolute;
 * overflow:hidden` - so it needs both given to it explicitly.
 *
 * Fill and radius are a *pair*, not two independent knobs: more radius flattens the
 * backdrop harder, so less fill is needed to hold the text up - and less fill is what
 * makes it look like glass rather than a tinted panel. Both are on trial together; see
 * the note on `settings.menuFill` / `menuBlur`.
 *
 * The `[data-overflow-below]` fade is re-stated because the host paints it with the
 * *opaque* `--dsw-specific-menu`; over a translucent panel that gradient shows up as a
 * solid band across the bottom of the menu.
 */

### A.6 `sidebarGlassCss`

/**
 * Glass inside the sidebar - the new-session button and the cost meter.
 *
 * Gated on whole-window scope, because in work-area scope the sidebar is deliberately
 * left exactly as the theme paints it. Frosting a button that sits on an opaque panel
 * buys nothing: there is no artwork behind it to refract, and it would be the one
 * touched element in a column that is supposed to stay untouched.
 *
 * The button paints `--dsw-alias-button-elevated-fill` and the meter card paints
 * `--dsw-alias-bg-layer-1`, neither of which is glass by itself, so both get the full
 * recipe rather than a token nudge.
 *
 * The meter is given a width instead of a margin, and the width is a percentage, so
 * it lands on the button's edges without this file ever knowing their pixel values.
 *
 * Two facts make that work. The meter is a *row* flex item - the cost meter plugin
 * registers into `sidebar.footer.action`, whose wrapper the host styles as
 * `_footerActions { display: flex; width: 100% }` - so its width is content-driven
 * unless something states one. The plugin states `width: 100%` itself, which is why
 * the card is full width out of the box. Saying `width: auto` here (2.17.0 did) hands
 * it back to the flex algorithm and the card shrinks to its longest line, which is
 * what left it 28px short on the right. So: keep a width, and take the button's
 * margins off it with `calc`.
 *
 * The percentage resolves against the same containing block the button uses - the
 * sidebar's content box - so `100% - 2px` plus a 2px right margin is the button's box
 * exactly. The button's own margin is `0 2px`, except on Windows, where the host
 * overrides it to `margin-left: 0` to sit flush under the title bar; the second rule
 * mirrors that so both edges agree on both platforms.
 *
 * The button is matched with `[class$=...]`, not `[class*=...]`: its children are
 * `_newSessionContent`, `_newSessionLabel`, `_newSessionLabelMask` and
 * `_newSessionShortcut`, every one of which contains `_newSession` as a substring and
 * would get a border and a drop shadow of its own.
 */

### A.7 `tooltipGlassCss`

/**
 * Tooltips and the workspace hover card.
 *
 * Both are dark on purpose: the host hardcodes `--dsw-hovercard-bg: #2C2C2E` on the
 * card element itself and paints that card's text `#fff` / `#cfd3d6`, and the simple
 * tooltip bubble draws `--dsw-alias-tooltip-bg`, which resolves to a *static* neutral.
 * Neither token is in `SURFACE_TOKENS`, so neither ever followed the wallpaper - they
 * stayed flat black rectangles floating over a frosted window.
 *
 * They cannot be turned light, because their label colours are hardcoded white. What
 * they can be is dark *glass*: keep the host's own colour, drop its alpha, and blur
 * whatever is behind it. That is the whole recipe, and it is written as
 * `color-mix(<host var> N%, transparent)` rather than as a literal, so the surface
 * keeps tracking the host's palette in both themes instead of pinning a hex here.
 *
 * The fill follows the shared `menuFill` slider so the hover card moves with the rest
 * of the glass - but with a hard floor, because this surface is *inverted*: the host
 * paints white text on it and the wallpaper behind can be bright. At the slider's low
 * end (20%) white glyphs would disappear into the backdrop entirely, so the card never
 * goes below 50% and the bubble never below 58% (it is a single line of 13px text).
 * In practice the slider moves these two only in its upper half; that is deliberate.
 * The blur, on the other hand, is shared outright: more radius buys back fill here too.
 *
 * The hover card is matched as `body > [class*="_card_"]` because the `HoverCard`
 * primitive portals it straight onto `<body>`; `_card_` on its own would also catch
 * cards that are not tooltips. The bubble is matched on `[data-side]`, which the
 * tooltip primitive always sets for its placement rules and which the message bubble
 * does not carry.
 *
 * The ring is an inset shadow, not a border: the card is `box-sizing: border-box` at a
 * fixed 244px, so a 1px border would eat into its own text box.
 */

### A.8 `statusGlassCss`

/**
 * Glass on the composer's status row, the session-header chips, and the cost entries.
 *
 * The row is `[data-composer-dock]`, the host's `InputBar` dock. It carries the
 * `conversation.composer.dock` slot plus the context meter, and it paints no background
 * of its own - which is why the transcript scrolls straight through it and the row reads
 * as loose text sitting on the window edge rather than as a status bar.
 *
 * The header chips all live in one slot. `_headerActions` renders nothing but
 * `renderSlot("conversation.session.header.actions")`, so "every button in that slot" is
 * exactly "the chips next to the title" - 智能体团队, 标准模式, 4 个子智能体, and the cost
 * entry. All of them are `<button>`s the host draws with `background: 0 0; border: 0`,
 * i.e. bare text; frosting them is what turns that strip into one row of panes.
 *
 * The two `费用明细` entries are the cost meter's own `.cm-btn`s, one in that header slot
 * and one in this dock. They paint `--dsw-alias-button-elevated-fill`, which is not in
 * `SURFACE_TOKENS`, and in the dark theme that token resolves to the static `#43454a`. A
 * static neutral is invisible to a remix that only rewrites tokens, so these stayed black
 * pills while everything around them went frosted.
 *
 * Gated on the finish switch with the composer, not always on: the status row is composer
 * chrome sitting directly under the message box, and the header row has to match it, so
 * "solid" has to mean solid here too.
 *
 * The `.cm-btn`s keep their host border width (`1px`) - only the colour moves. The other
 * chips have no border at all, so they get the chip's `.5px` hairline; a full pixel on
 * both sides would visibly fatten a 28px-tall control.
 *
 * `:not([class*="_trigger"])` keeps the popover triggers bare. 智能体团队 and 4 个子智能体
 * are `<button class="..._trigger">` / `<button class="..._switcherTrigger">`, and a
 * permanent pill around a dropdown opener reads as a pressed button that never unpresses -
 * the popover that opens is where the glass belongs. 标准模式 is a filled chip in the
 * host's own design (`--dsw-alias-state-business-tertiary`), so it stays filled here too.
 *
 * ⚠️ 补（v1.2.0）：这条状态栏后来成了**唯一**一个保留真 `backdrop-filter` 的 pane。
 * 理由就是上面那句「转写区直接从它底下穿过去」—— 别的 pane 底下只有糊过的壁纸，再糊一遍
 * 是白花钱（v2.47.0 的结论）；它底下会滚过正文，只给填充的话那些字会透上来糊成一片。
 * 输入框卡片是同一个处境，所以两处现在共用 `menuBlurOf` 和同一个 `saturate(160%)`。
 * 前提是它必须是 `[data-composer-card]` 的**兄弟**而不是后代 —— 卡片是 backdrop root，
 * 后代在里面采样只能采到卡片内部，模糊会静默失效（`/` 菜单就是这么死的）。
 */

### A.9 `menuGlassCss`

/**
 * Glass inside the team popover.
 *
 * The panel itself is already frosted - the host paints it with `--dsw-specific-menu`
 * plus `--dsw-menu-backdrop-filter` on a `::before` - and it matches the subagent panel
 * exactly. What did not match was the contents: the member cards paint
 * `--dsw-alias-bg-layer-2`, the theme's own opaque layer, so inside a see-through panel
 * they read as dark blocks.
 *
 * The subagent panel is the reference the user pointed at: its rows are completely
 * transparent, with a hover tint and nothing else. So the member card keeps no fill at
 * all. An earlier version gave it the chip recipe and it still looked wrong - the chip's
 * fill is `color-mix(--dshbg-raw-base 45%)`, and `--dshbg-raw-base` is derived from the
 * wallpaper's tone, so over a dark wallpaper the "chip" came out as a dark navy block.
 * No fill has no such failure mode.
 *
 * `[data-team-panel]`, not the header slot: the panel is rendered through
 * `createPortal` into `document.body`, so it is **not** a descendant of
 * `conversation.session.header.actions` - a slot-scoped selector silently matches
 * nothing. The host puts `data-team-panel` on the panel root precisely as a hook, and
 * unlike a hashed class it survives rebuilds.
 *
 * Task cards keep a light tint (the panel re-mixes `--dsw-alias-bg-layer-2` for
 * everything inside it) because they are blocks of prose, not rows - but they lose the
 * opacity that made them black holes.
 *
 * `button[class*="_member"]` and not `[class*="_member"]`: the card's children are
 * `_memberName`, `_memberNameText`, `_memberText`, `_memberDot` and `_memberModel`, and
 * the card for the current session also carries `_memberCurrent` - so neither `$=` nor a
 * bare `*=` picks out the card alone. Only the card itself is a button, which also keeps
 * the workflow-run panel's `_memberButton` out of reach.
 */

### A.10 `previewCardCss`

/**
 * The turn navigator's hover preview - the card that pops out to the left of the little
 * marks down the right edge of the transcript.
 *
 * It is `xpvNua_preview`: `width: min(300px, 100cqw - 120px)`, one 13px bold prompt line
 * plus up to three 12px caption lines, `--dsw-radius-lg`, `--dsw-elevation-panel`, and
 * `background: var(--dsw-alias-bg-layer-1)`.
 *
 * That token *is* in the remix list, so before this rule existed the card simply
 * followed the wallpaper and fell to ~28% - and at that fill the paragraph it is
 * covering read straight through it, so neither the preview nor the paragraph was
 * legible. Version 2.16 pinned it back to the captured, un-remixed layer value, i.e.
 * fully opaque. That fixed the reading and left the one flat black rectangle in an
 * otherwise frosted window - which is what the user spotted.
 *
 * So it becomes glass like everything else: the shared fill and blur from the two
 * trial sliders, over the captured layer colour. Two things make it work here:
 *
 * - **No ancestor of it carries a `backdrop-filter`.** The card is a sibling of
 *   `_scroller`, not a child (`<nav> > [scroller][marks] + [preview]`), and neither
 *   `_slot` nor `_frame` paints one - `contain: layout` and `container-type` only
 *   create a containing block, not a backdrop root. If the blur ever stops working
 *   again, check that chain first (see the note on `menuSurfaceCss`).
 * - **A hard fill floor.** This is a card lying on top of body text, not a pane beside
 *   it: at the slider's low end the 12px caption would be fighting blurred glyphs for
 *   the same pixels. It never goes below 50%, the same floor the workspace hover card
 *   uses, because both are the same kind of surface. The slider moves it only in its
 *   upper half; that is deliberate, and the blur is still shared outright.
 *
 * Matched on the response line rather than the bare `_preview` class, which several
 * other modules also use for things that are not popovers (`QueueDock`'s inline
 * preview, the file-diff hover card, the plan viewer).
 */

### A.11 `glassPane`

/**
 * The frosted-pane recipe, shared by every surface that gets the liquid-glass look.
 *
 * The wallpaper is already blurred at the `html::before` layer, so the pane's own
 * `backdrop-filter` mostly adds saturation and edge definition rather than doing the
 * blurring work. That is deliberate: it keeps the GPU cost of a long transcript with
 * many blocks low while still reading as glass.
 *
 * **Never put this on an ancestor of a menu.** `backdrop-filter` creates a backdrop
 * root, and a menu that hangs outside its ancestor's box then samples an empty area -
 * its blur silently does nothing. That is exactly what the composer card used to do to
 * the `/` command menu, which is why `composerGlassCss` hand-rolls the pane instead of
 * calling this. The rule of thumb: leaves are fine, containers that own popovers are
 * not.
 *
 * **No `backdrop-filter` at all** (v2.47.0). A pane's backdrop is the wallpaper, and
 * the wallpaper is already blurred at the `html::before` layer - so this element used
 * to pay for a full backdrop snapshot to re-blur something that was already blurred.
 * The saturation that snapshot did buy now lives on the wallpaper layer itself, which
 * costs one pass per wallpaper change instead of one per pane per frame.
 *
 * What it cost was not just GPU time. Chromium renders each `backdrop-filter` element
 * into a surface sized by its backdrop root, and a surface that is not ready in a frame
 * shows as nothing at all. Streaming a reply repaints the transcript every frame, the
 * pane's snapshot has to be retaken every frame, and the one frame that lost the race
 * showed the transcript column as bare wallpaper while the left column - whose panes
 * were not repainting - stayed intact. That is the flicker.
 */

### A.12 `glassChip`

/**
 * The small-pane variant, for inline code.
 *
 * Same idea, three differences, all of them about being 20px tall and appearing dozens
 * of times in one screen:
 *
 * - More fill (45% against the pane's 22%). Inline code has to stay distinguishable
 *   from the prose around it; at 22% it dissolves into the wallpaper and the monospace
 *   run stops reading as a token. 45% is where 12px monospace in the light label colour
 *   still clears 5:1 against a mid-bright wallpaper - below that the chips are pretty
 *   but unreadable, which is the one thing a code token cannot be.
 * - No drop shadow, only the top inner highlight. Fifteen floating shadows in a
 *   paragraph is noise, and the hairline border already lifts the chip off the page.
 * - The border stays at the host's `.5px`, only its colour changes. Going to 1px would
 *   add 1px to every chip's box, and these are inline elements - a hundred of them in
 *   one paragraph is a hundred little reflows of the line they sit on.
 * - Blur capped at 10px. The backdrop is already blurred at the `html::before` layer,
 *   so a bigger radius buys nothing visually while multiplying the cost by the number
 *   of chips on screen.
 *
 * `border` is a parameter rather than a constant because the same recipe is reused on
 * block-level buttons (the cost-detail pills), where the host already draws a 1px
 * border and shrinking it to .5px would visibly thin an edge that is not inline.
 *
 * No `backdrop-filter`, for the same reason as `glassPane`: the chips sit on the
 * transcript's own fill with wallpaper behind it, and that wallpaper is already blurred
 * at the `html::before` layer. A paragraph with a dozen chips used to take a dozen
 * backdrop snapshots per frame while a reply streamed in.
 */
