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
| 输入框 | `[data-composer-card]`、底部状态栏、头部那排胶囊、两处**「费用明细」胶囊** | 跟随「质感」开关 |
| 侧栏 | 新会话按钮、左下角计费器 | 只在**整窗**作用域下开 |

**转写区常开**：它们是内容不是外壳，压在工作区的壁纸上面。一块实色卡片铺在壁纸中间，读起来就是画面上打了个洞。所以「质感」切回实心只说明输入框要实心，不该连带把整篇对话里的代码块和文件卡都拉回实色。

**侧栏跟着侧栏走**：只改工作区时左栏要保持主题原样，给一个不透明的面板磨砂没有意义——后面没有壁纸可折射，还会成为这一列里唯一被碰过的元素。整窗模式下左栏本身就是玻璃，这两块才跟着变。

**状态栏跟输入框走**：它就在消息框正下方，是同一坨外壳。实心模式如果只留它一条磨砂，那它就成了整个窗口里唯一一块玻璃——所以「质感」管到底。

八个钩子，都不靠猜哈希类名：

| 表面 | 钩子 | 为什么稳 |
|---|---|---|
| 输入框 | `[data-composer-card]` | 官方 data 属性 |
| 底部状态栏 | `[data-composer-dock]` | 官方 data 属性（宿主的 `InputBar.dock`） |
| 头部胶囊 | `[data-slot="conversation.session.header.actions"] button` | 槽位 data 属性；`_headerActions` 里只渲染这一个槽，所以「槽里每个 button」正好是标题旁边那一排 |
| 费用明细胶囊 | `[data-composer-dock] .cm-btn`、`[data-slot="conversation.session.header.actions"] .cm-btn` | 槽位 data 属性 + 计费器自己的类名 |
| 用户气泡 | `[data-chat-flow-kind="user"] [class*="_bubble"]` | flow item 的 data 属性 + 本地类名 |
| 代码块 | `[class*="_block_"]:has([data-code-block-banner])` | 类名是 `_block_<hash>_<line>`，`_block_` 这半截能跨版本存活 |
| 附件卡 | `[class*="_fileCard"]` | 类名是 `<hash>_fileCard`，`_fileCard` 是稳定那半截 |
| 交付卡 | `[data-presented-file]`（备用：`[class$="_file"]:has(> [class$="_fileBody"])`） | 见下 |
| 内联 code | `[class*="_markdown_"] :not(pre) > code` | 类名是 `_markdown_<hash>_<line>`；末尾那个下划线把 `_markdownPreview` 挡在外面 |
| 新会话 | `[class$="_newSession"]` | 类名是 `<hash>_newSession`；必须用 `$=`，见下 |
| 计费器 | `.cm-footer-stack.summary:not(.rail)` | 插件自己的类名，不是哈希 |

**状态栏为什么原来像一行散字。** `[data-composer-dock]` 自己不铺任何底色——它只是把 `conversation.composer.dock` 槽和右侧的上下文计量表（34% 那个环）摆成一行，所以转写区的文字会直接从它下面穿过去。铺一块面板之后它才真正读作「状态栏」，而不是贴着窗口边的一行无主文字。它原本 `padding-top: 4px`、下边距为 0，字是贴着底边压的，所以面板化时把内边距补成对称的 `3px 8px`，外加 `box-sizing: border-box` 免得 16px 横向内边距把盒子撑出容器。

**两处「费用明细」为什么一直是黑胶囊。** 它们是计费器自己的 `.cm-btn`，画 `var(--dsw-alias-button-elevated-fill)`。这个 token 不在 `SURFACE_TOKENS` 里，而且暗色主题下它解析成**静态中性色 `#43454a`**——重混只改写 token，够不到一个静态值，所以它们从头到尾没被碰过。位置有两处：一处是会话头部（`conversation.session.header.actions` 槽），一处就是底部状态栏，两处都铺。这里跟内联芯片的唯一差别是**边框保持宿主的 1px**：按钮是块级元素，把它削到 `.5px` 只会让一条本来不该动的边变细，而内联芯片那套 `0.5px` 是为了避免行内重排才必须的。

**头部那排胶囊为什么用一个槽就能全选中。** `_headerActions` 这个容器里只渲染了 `renderSlot("conversation.session.header.actions")` 一个东西，所以「这个槽里的每个 button」正好等于「标题旁边那排」：智能体团队、标准模式、4 个子智能体、费用明细。它们全都是宿主用 `background: 0 0; border: 0` 画的纯文字按钮，铺上玻璃才从一排散字变成一排面板。这些按钮本来没有边框，所以给的是芯片那套 `.5px` 发丝边；只有 `.cm-btn`（费用明细）保留自己的 1px——给一个 28px 高的控件两侧各加 1px 会明显变胖。

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

### 标题超长就滚动

会话标题是面包屑，宿主封顶 `max-width: 220px` + `text-overflow: ellipsis`，长名字从第 220px 起就没了。纯 CSS 补不了这个洞：滚动的距离是 `scrollWidth - clientWidth`，没有任何长度单位能表达「藏了多少」。

所以分成两半：**clip 在样式表里，距离由 JS 量出来交给 Web Animation**。

- 动的是 `text-indent` 而不是 `transform`。要动的是元素**内部**的文字；`transform` 会把整个盒子——连悬停底色和点击区域——拖到旁边那几个胶囊上面去。
- 量之前必须先 `cancel()` 正在跑的动画。`text-indent` 会把文字整体左移，`scrollWidth` 报的就是移动后的溢出边，不先停就会越量越小、标题一路往左爬。
- 重新测量的触发源只有标题自己：一个盯面包屑的 `ResizeObserver`，加一个**过滤过**的 `MutationObserver`。转写区每吐一个 token 都在改 DOM，全局监听会让跑马灯一秒重启几十次。
- 面包屑的当前那一节是 `<span>`，祖先才是 `<button>`，两个都要选中。`_crumbSeg` / `_crumbSep` / `_crumbs` 也含 `_crumb` 子串，所以按名字排除，而不是靠层级位置猜。
- 动画节奏是「停 → 滑到尾部 → 停 → 滑回来」，不是匀速跑圈：速度按距离算，`7s + 每像素 60ms`，上限 26s。停的两段各占 14%，所以扫一眼就能读到开头。
- 关掉壁纸时动画跟着停——因为配套的 `text-overflow: clip` 在激活作用域里，没有它，滑动的标题会一直把省略号钉在右边。

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

118 项检查，覆盖：模块契约、样式表注入、壁纸层、token 捕获与重混、**作用范围（左栏是否被重混）**、对话区与输入框独立不透明度、标题栏通栏、标题栏按钮探针、设置页及其作用域、液态玻璃三档归属与两套配方（面板 / 芯片）、底部状态栏、头部胶囊、用户气泡、两处费用明细、标题滚动选择器、配置页实际渲染、五种字体模式、cost-meter 兼容层、生命周期、CSS 语法与选择器前缀。

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
