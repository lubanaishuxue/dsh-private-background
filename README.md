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

磨砂玻璃分三档，因为这三类表面归属不同：

| 档 | 谁 | 什么时候开 |
|---|---|---|
| 转写区 | 文件卡片、交付卡片、代码块、**内联 code 芯片**、**用户消息气泡** | **常开** |
| 输入框 | `[data-composer-card]`、底部状态栏、头部那排胶囊、底部那颗**「费用明细」胶囊**、**「回到最下面」圆钮** | 跟随「质感」开关 |
| 侧栏 | 新会话按钮、**历史记录背后那一整块面板**、左下角计费器 | 只在**整窗**作用域下开 |

**侧栏历史记录：一块面板托住整列，行保持平的。** 宿主平时不给这些行铺任何底色，只有 hover / 选中时上一点 `--dsw-alias-interactive-bg-hover`。压在壁纸上，整列标题就是「浮在画上的散字」。

给**每一行**各自加一块圆角填充是错的，试过两版都不行：行与行只隔 2px（宿主 `_flatList > * + *`），每行一块就变成「一串药丸」，文件夹和会话一样重，选中的那条反而看不出来；而且行高 32px、`content-box`，加 1px 边框会把每行撑高，二十行二十个投影也只是噪音。

正确的做法跟宿主自己的假设一致，也是这类应用的通行结构（VS Code、ChatGPT、Claude）：**一块面板铺在列表背后，行完全不动**，hover / 选中交给宿主自己的规则去上色。所以 `[class*="_sessionRow"]` / `[class*="_projectRow"]` / `[class*="_searchResultRow"]` **一条规则都没有**——任何行级背景都会把宿主的选中态盖掉。

面板挂在 `[class*="_treeBody"]`（`_listArea` 的 `-12px` 负边距把它还原成左右各内缩 12px，正好是一张卡片的位置），48% 填充 + 10px 圆角 + inset 环 + 磨砂。两个细节：

- 环用 inset 阴影不用 border——`_list` 用负边距给滚动条让位，`content-box` 上 1px 边框会把那条槽推歪。
- 面板要 `padding: 8px 0`。`_list` 是按**矩形**裁内容的，贴着底边那一行一旦 hover，自己的直角就会从面板的圆角里戳出来。8px 已经越过 10px 圆角还有弧度的位置（y=8 处弧只内收 0.2px）。
- 宿主那条 `_fade`（列表底部 24px 的渐隐）**故意不动**。它渐隐到 `--dsw-specific-sidebar-fill`，而这个 token 在整窗模式下也被重混过，本身已经是半透明的水洗，不是实心色带。盖掉它只会把软边换成硬边。

**转写区常开**：它们是内容不是外壳，压在工作区的壁纸上面。一块实色卡片铺在壁纸中间，读起来就是画面上打了个洞。所以「质感」切回实心只说明输入框要实心，不该连带把整篇对话里的代码块和文件卡都拉回实色。

**有一类表面必须钉回不透明：悬停预览卡。** 转写区右侧那排小标记，悬停时会弹出「这一问 + 三行回答」的预览卡（`xpvNua_preview`），它画的是 `--dsw-alias-bg-layer-1`，而这个 token **在**重混列表里，于是卡片掉到面板那一档的透明度，背后的正文原样穿过来——预览看不清，被它盖住的那段正文也看不清。预览卡是唯一「透明度不是风格而是 bug」的表面，所以用捕获下来的原始 layer 值钉回去；卡片自己的圆角和 `--dsw-elevation-panel` 都留着，仍然读得出浮在页面上。

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
| 历史记录面板 | `[class*="_treeBody"]` | 类名是 `<hash>_treeBody`，本地名稳定；**行本身一条规则都不加**，见上 |
| 悬停预览卡 | `[class*="_preview"]:has([class*="_previewResponse"])` | 好几个模块都用 `_preview` 命名，用「里面有没有 response 那行」收口 |
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

## 九、改了代码之后

```bash
node tools/smoke-test.cjs
```

179 项检查，覆盖：模块契约、样式表注入、壁纸层、token 捕获与重混、**作用范围（左栏是否被重混）**、对话区与输入框独立不透明度、标题栏通栏、标题栏按钮探针、设置页及其作用域、液态玻璃四档归属与三套配方（面板 / 芯片 / 悬浮控件 / 历史记录面板）、底部状态栏、头部胶囊、用户气泡、费用明细胶囊与头部那颗的隐藏、回到最下面圆钮、侧栏历史面板（行必须一条规则都没有）、悬停预览卡不透明、团队面板（portal 与内层 token 重混）、代码块三处底色与标题栏、标题的「放得下就不滚」与 `max-width` 还原时机、选择器 / 测量方式 / 无缝循环 / 自激防护 / 声明式动效与关键帧、配置页实际渲染、五种字体模式、cost-meter 兼容层、生命周期、CSS 语法与选择器前缀。

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
