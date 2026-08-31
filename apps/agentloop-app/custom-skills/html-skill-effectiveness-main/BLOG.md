# 🎨 让 AI 输出更美的 HTML：html-skill-effectiveness 技能包全解析

> **AI 每天都在生成海量的 Markdown，但有多少是你真正"看进去"的？**
>
> 本文从一个实际痛点出发，带你一步步了解为什么 HTML 能替代 Markdown 成为更好的 AI 输出载体，以及我们如何通过一个 Skill 包让这件事变得简单、可复用、可落地。

---

## 目录

1. [痛点：AI 输出为什么总是"扫一眼就跳过"？](#1-痛点ai-输出为什么总是扫一眼就跳过)
2. [根本原因：Markdown 的三大局限](#2-根本原因markdown-的三大局限)
3. [解决方案：用 HTML 替代 Markdown](#3-解决方案用-html-替代-markdown)
4. [设计系统：让每个页面都有一个"好看的底子"](#4-设计系统让每个页面都有一个好看的底子)
5. [11 种设计模式：覆盖 AI 输出的大部分场景](#5-11-种设计模式覆盖-ai-输出的大部分场景)
6. [v2.0 新特性：从"能看"到"好看"再到"好用"](#6-v20-新特性从能看好看到好用)
7. [v2.1：The Critique Revolution — 从"生成一次"到"生成、批判、精炼、收敛"](#7-v21the-critique-revolution--从生成一次到生成批判精炼收敛)
8. [实战：20 个真实办公场景全展示](#8-实战20-个真实办公场景全展示)
9. [安装与使用](#9-安装与使用)
10. [最佳实践与避坑指南](#10-最佳实践与避坑指南)
11. [总结与获取](#11-总结与获取)

---

## 1. 痛点：AI 输出为什么总是"扫一眼就跳过"？

你有没有这样的体验——

让 AI 对比三套技术方案，它给你列了三个列表，每个列表标题下面几个"优点/缺点"，排成一长串。你**知道**信息都在那里，但要**真的看进去**——在心里把三套方案拉平对比、判断哪套更适合自己的场景——却需要费不少脑子。

这不是 AI 的问题，是**输出载体**的问题。

AI 默认输出 Markdown，而 Markdown 的本质是**线性文本**。它擅长的是「顺序叙述」，不擅长的是「空间表达」——也就是那些需要靠**视觉布局**才能更快理解的信息：

- 三套方案的**横向对比**
- 一段代码的**增删变化**
- 一条数据流的**走向**
- 一堆指标中**哪个好、哪个差**

这些信息，用 Markdown 写出来**都能读**，但读起来**不痛快**。

---

## 2. 根本原因：Markdown 的三大局限

为了让问题更具体，我们拆解一下 Markdown 在信息表达上的三个先天不足：

### 2.1 没有空间布局

Markdown 是线性的，从上到下排列。但人脑处理信息的方式不是线性的——我们靠**空间关系**来理解结构。

| 你想表达 | Markdown 怎么做 | 读者体验到什么 |
|----------|----------------|---------------|
| 三套方案对比 | 三个 `## 标题` + 列表 | 上下滚动，脑内对齐 |
| 流程走向 | 数字列表 1→2→3 | 想象连线 |
| 层级关系 | 缩进列表 | 数缩进层级 |

### 2.2 没有图表能力

趋势、对比、分布——这些信息在 Markdown 里只能靠**数字表格**来表达。而人眼对**图形**的识别速度比文字快几个数量级。

```markdown
| 月份 | 销售额 |
|------|--------|
| 1月  | 120K   |
| 2月  | 135K   |
| 3月  | 145K   |
```

一个 3 月的销售额是上涨还是下跌？你得**读数字比较**。换成柱状图，一眼就知道。

### 2.3 完全没有交互

Markdown 是纯静态文本。你不能：

- ❌ 拖拽一个卡片到"已完成"列
- ❌ 滑动滑块看参数变化
- ❌ 点击步骤按钮逐步学习
- ❌ 切换 Tab 查看不同的代码视角

这些能力在一个 AI 输出的文档中**本可以存在**——因为浏览器原生支持。

---

## 3. 解决方案：用 HTML 替代 Markdown

既然浏览器就在那里，为什么不直接让 AI 输出 HTML？

**HTML 能做到的事情，Markdown 完全做不到：**

| 维度 | Markdown | HTML |
|------|----------|------|
| **布局** | 线性排列 | 并排卡片、网格、空间对齐 |
| **表格** | 管道符画线，丑且不可操作 | 排序、筛选、有样式、可交互 |
| **图表** | ❌ 完全没有 | SVG 柱状图、迷你趋势线、饼图 |
| **交互** | ❌ 静态文本 | 滑动、点击、拖拽、折叠展开 |
| **代码展示** | 灰色代码块 | 语法高亮、行号、Diff 红绿配色 |
| **排版** | 无字体控制 | 字体栈、行距、字距、颜色系统 |

但问题来了——**AI 默认不会生成好看的 HTML**。

让 AI 写 HTML 不难，但让它写出**有设计系统、有视觉层次、有交互逻辑**的 HTML，需要一套清晰的规则和模板。这就是 **html-skill-effectiveness** 存在的意义。

### 3.1 项目简介

[![GitHub](https://img.shields.io/badge/GitHub-YardonYan%2Fhtml--skill--effectiveness-181717?logo=github)](https://github.com/YardonYan/html-skill-effectiveness)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE.txt)

**html-effectiveness** 是一个面向 AI Agent（OpenClaw / Claude）的 Skill 技能包。它通过一份 `SKILL.md` 文件，教会 AI 如何输出**自包含、零依赖、单文件**的高质量 HTML 页面。

> 一句话：**把 AI 聊天的输出，从"能看"变成"好看"。**

GitHub 地址：https://github.com/YardonYan/html-skill-effectiveness

### 3.2 文件结构

```
html-skill-effectiveness/
├── SKILL.md                          # 核心技能定义（AI 读取的指令）
├── README.md                         # 项目文档
├── LICENSE.txt                       # Apache 2.0
├── BLOG.md                           # 本文
├── INTEGRATION_SUMMARY.md            # 版本整合历史
├── indexxxxxxx_en.html               # 英文展示页（含 13 种模式演示）
├── indexxxxxxx_zh.html               # 中文展示页
└── references/
    ├── pattern-examples.md           # 代码片段参考
    ├── complete-examples.md          # 完整示例
    ├── critique-guide.md             # 完整 critique 指南 (NEW)
    └── frame-effects.md              # Frame Effects 模式参考 (NEW)
```

---

## 4. 设计系统：让每个页面都有一个"好看的底子"

好看不是碰运气的。每一个好看的 HTML 页面，背后都有一套**设计系统**——一组有共识的颜色、字体、间距规则。

这个 Skill 预置了一套完整的设计令牌：

### 4.1 配色体系

```css
:root {
  --ivory: #FAF9F5;   /* 页面背景 —— 暖白不刺眼 */
  --slate: #141413;   /* 正文标题 —— 近乎黑色但有温度 */
  --clay:  #D97757;   /* 强调色 —— 赤陶红，温暖醒目 */
  --oat:   #E3DACC;   /* 次级强调 —— 燕麦色 */
  --olive: #788C5D;   /* 成功/正向 —— 橄榄绿 */
  --rust:  #B04A3F;   /* 错误/破坏性 —— 锈红色 */
  --sky:   #6A8CAF;   /* 信息/中性 —— 天蓝色 */
}
```

为什么选这些颜色？因为**暖调**。纯黑 `#000` + 纯白 `#FFF` 给人"文档"的感觉，而 `ivory`（米白）+ `clay`（赤陶）的搭配让页面读起来像一本**精装杂志**，而不是技术手册。

### 4.2 字体层级

```css
:root {
  --serif: ui-serif, Georgia, "Times New Roman", serif;
  --sans:  system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono:  ui-monospace, "SF Mono", Menlo, Monaco, monospace;
}
```

| 元素 | 字体 | 字号 | 用途 |
|------|------|------|------|
| H1 | Serif | clamp(38px, 5.4vw, 62px) | 页面标题 |
| H2 | Serif | 26-28px | 章节标题 |
| H3 | Serif | 19-22px | 卡片标题 |
| 正文 | Sans | 14-15px | 内容阅读 |
| 代码 | Mono | 11-13px | 代码展示 |

### 4.3 间距与圆角

```css
--radius-panel: 12px;    /* 卡片圆角 */
--radius-row:    8px;    /* 内部元素圆角 */
--radius-pill: 999px;    /* 标签药丸圆角 */
--border: 1.5px solid var(--g300);
```

这些值不是随意选的——12px 圆角刚好给卡片一种"精致但不圆滑"的感觉；1.5px 边框比常见的 1px 粗一点，在暖色背景上更有存在感。

---

## 5. 11 种设计模式：覆盖 AI 输出的大部分场景

有了设计系统还远远不够，我们需要知道**在什么场景下用什么结构**。Skill 定义了 11 种模式，每一种对应一个常见的 AI 输出场景。

下面逐一展开，每种模式都会给出：场景说明、Markdown 写法、HTML 改写代码、💡 关键差异。

---

### 5.1 🔄 并列对比（Side-by-Side Comparison）

**场景**：技术选型、方案对比、设计选项

**Markdown 写法**：
```markdown
## 方案对比

### 方案 A：客户端渲染
优点：导航快、交互丰富
缺点：首屏慢、SEO 差

### 方案 B：静态生成（推荐）
优点：加载快、SEO 好、成本低
缺点：构建时间长
```

**HTML 改造后**：

```html
<div class="grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px">
  <div class="card">
    <span class="badge">方案 A</span>
    <h3>客户端渲染</h3>
    <ul class="pros"><li>✅ 导航快</li><li>✅ 交互丰富</li></ul>
    <ul class="cons"><li>❌ 首屏慢</li><li>❌ SEO 差</li></ul>
  </div>
  <div class="card best">
    <span class="badge" style="background:#141413;color:#FAF9F5">★ 推荐</span>
    <h3>静态生成</h3>
    <ul class="pros"><li>✅ 加载快</li><li>✅ SEO 好</li><li>✅ 成本低</li></ul>
    <ul class="cons"><li>❌ 构建时间长</li></ul>
  </div>
</div>
```

**对应 CSS**：

```css
.card {
  background: #fff;
  border: 1.5px solid var(--g300);
  border-radius: 14px;
  padding: 28px;
  transition: transform 150ms ease, box-shadow 150ms ease;
}
.card:hover {
  transform: translateY(-3px);
  box-shadow: 0 10px 30px rgba(20,20,19,.10);
}
.pros li::before { content: "✓ "; color: var(--olive); }
.cons li::before { content: "✗ "; color: var(--rust); }
```

> **💡 关键差异**：Markdown 用列表做对比，读者需要在心里"对齐"三个方案的优缺点。HTML 用并排卡片让推荐项自动突出，悬停还有微妙动效——信息获取速度提升一个数量级。

---

### 5.2 📝 代码审查（Annotated Diff / Code Review）

**场景**：PR 评审、代码变更前后对比

**Markdown 写法**：
```diff
- const token = jwt.sign(payload, secret)
+ const token = jwt.sign(payload, secret, { expiresIn: '1h' })
```

**HTML 改造后**：
```html
<div class="diff-block">
  <div class="diff-line del">
    <span class="ln">10</span>
    - const token = jwt.sign(payload, secret)
  </div>
  <div class="diff-line add">
    <span class="ln">10</span>
    + const token = jwt.sign(payload, secret, { expiresIn: '1h' })
  </div>
</div>
<span class="severity critical">CRITICAL</span>
<span> 缺少 TTL，安全风险</span>
```

**对应 CSS**：

```css
.diff-line.add {
  background: #F0F7EC;
  border-left: 3px solid var(--olive);
}
.diff-line.del {
  background: #FDF2F0;
  border-left: 3px solid var(--rust);
}
.severity.critical { background: var(--rust); color: #fff; padding: 2px 8px; border-radius: 999px; font-size: 10px; }
.severity.warn     { background: var(--clay); color: #fff; }
.severity.note     { background: var(--olive); color: #fff; }
```

> **💡 关键差异**：Diff 本质上是**空间信息**——删除用红色背景 + 左边框，新增用绿色背景 + 左边框。不读正文、只看颜色也知道改了哪、改了什么。再加上彩色严重性标签，评审效率大幅提升。

---

### 5.3 🏗️ 架构图（Module Map / Architecture Diagram）

**场景**：系统架构、模块依赖、数据流

**Markdown 写法**：
```markdown
AuthService 依赖 UserService 和 TokenManager，TokenManager 依赖 UserDB。
```

**HTML 改造后**：
```html
<svg viewBox="0 0 400 300">
  <defs>
    <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
      <path d="M0,0 L0,6 L9,3 z" fill="#D1CFC5"/>
    </marker>
  </defs>
  <rect x="140" y="20" width="120" height="40" rx="6"
        fill="#fff" stroke="#D97757" stroke-width="1.5"/>
  <text x="200" y="45" text-anchor="middle" font-family="monospace" font-size="12">AuthService</text>
  <rect x="140" y="100" width="120" height="40" rx="6"
        fill="#fff" stroke="#788C5D" stroke-width="1.5"/>
  <text x="200" y="125" text-anchor="middle" font-family="monospace" font-size="12">UserService</text>
  <line x1="200" y1="60" x2="200" y2="98"
        stroke="#D1CFC5" stroke-width="1.5" marker-end="url(#arrow)"/>
</svg>
```

交互 tooltip：

```javascript
document.querySelectorAll('.node').forEach(node => {
  node.addEventListener('click', () => {
    const data = detailData[node.dataset.step];
    document.getElementById('panel').innerHTML = `<h3>${data.title}</h3><p>${data.desc}</p>`;
  });
});
```

> **💡 关键差异**：架构是**图**不是**文**。SVG 箭头 + 彩色方框让依赖关系一目了然，点击节点还能展开详情。

---

### 5.4 🎨 设计系统展示（Living Design System）

**场景**：品牌色板、组件库、设计令牌

```css
.swatch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 16px;
}
.swatch { border-radius: 8px; overflow: hidden; border: 1.5px solid #D1CFC5; }
.swatch .color { height: 80px; }
.swatch .label { padding: 10px 12px; background: #fff; font-family: monospace; font-size: 12px; }
```

```html
<div class="swatch-grid">
  <div class="swatch"><div class="color" style="background:#D97757"></div><div class="label">--clay: #D97757</div></div>
  <div class="swatch"><div class="color" style="background:#788C5D"></div><div class="label">--olive: #788C5D</div></div>
</div>
```

> **💡 关键差异**：设计系统需要**可视化**——色块比 Hex 值直观得多，组件变体并排展示比文字描述清晰。

---

### 5.5 📊 幻灯片（Slide Deck）

**场景**：演示文稿、项目汇报、技术分享

```css
body {
  scroll-snap-type: y mandatory;
  overflow-x: hidden;
}
.slide {
  width: 100vw;
  height: 100vh;
  scroll-snap-align: start;
  scroll-snap-stop: always;
}
```

```javascript
// 键盘导航
document.addEventListener('keydown', (e) => {
  const slides = document.querySelectorAll('.slide');
  const current = Math.round(window.scrollY / window.innerHeight);
  if (e.key === 'ArrowDown') {
    slides[Math.min(current + 1, slides.length - 1)]?.scrollIntoView();
  }
});
```

> **💡 关键差异**：Markdown 的"幻灯片"就是分节符。HTML 的幻灯片是**真正的全屏演示**，支持键盘翻页、进度指示、甚至演讲者备注。

---

### 5.6 📖 交互式讲解（Interactive Explainer）

**场景**：概念教学、功能文档、研究总结

```html
<details class="deep-dive">
  <summary>虚拟节点放置是如何工作的？</summary>
  <div class="content">
    <p>每个节点被哈希到环上的一个点...</p>
  </div>
</details>
```

```css
details.deep-dive {
  border: 1.5px solid #D1CFC5;
  border-radius: 12px;
  padding: 16px 20px;
}
details summary {
  font-weight: 500;
  cursor: pointer;
}
details summary::before {
  content: "▸";
  margin-right: 8px;
  color: #D97757;
  display: inline-block;
  transition: transform 150ms;
}
details[open] summary::before {
  transform: rotate(90deg);
}
```

> **💡 关键差异**：长文用折叠控制信息密度，读者按需展开。TL;DR 放最上面，深度内容藏折叠里——这是 Markdown 做不到的渐进式披露。

---

### 5.7 📈 状态报告（Status / Incident Report）

**场景**：周报、事故复盘、进度跟踪

```html
<span class="health on-track">正常</span>
<span class="health at-risk">有风险</span>
<span class="health blocked">阻塞</span>
```

```css
.health {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: monospace;
  font-size: 11px;
  padding: 4px 10px;
  border-radius: 999px;
}
.health.on-track { background: #E8F0E0; color: #788C5D; }
.health.at-risk  { background: #F5E8E4; color: #D97757; }
.health.blocked  { background: #F5E8E4; color: #B04A3F; }
```

> **💡 关键差异**：状态标签用**颜色 + 形状**双重编码，扫一眼就知道项目健康状况。迷你柱状图让趋势一目了然。

---

### 5.8 🔀 流程图（Flowchart / Process Diagram）

**场景**：流水线、决策树、工作流

```html
<svg viewBox="0 0 600 400">
  <g class="node" data-step="build" cursor="pointer">
    <rect x="100" y="100" width="120" height="50" rx="6" fill="#fff" stroke="#D1CFC5"/>
    <text x="160" y="130" text-anchor="middle">构建</text>
  </g>
  <!-- 箭头 -->
  <line x1="220" y1="125" x2="300" y2="125" stroke="#D1CFC5" marker-end="url(#arrow)"/>
</svg>
<div class="detail-panel" id="details">点击节点查看详情</div>
```

> **💡 关键差异**：流程是**空间结构**不是**线性文本**。SVG 让流程图可交互，点击节点展开详情，比静态图灵活得多。

---

### 5.9 🖼️ SVG 插图（SVG Illustration Sheet）

**场景**：博客配图、示意图、图标集

```css
svg.figure .st { stroke: #87867F; fill: none; stroke-width: 2.5; }
svg.figure .fl { fill: #D1CFC5; }
svg.figure .cl { fill: #D97757; }
```

> **💡 关键差异**：SVG 是**代码级**的图形——可搜索、可复制、可动画、可交互。比截图清晰，比图片轻量。

---

### 5.10 🛠️ 自定义编辑器（Custom Editor / Triage Board）

**场景**：排序、标记编辑、提示词调优、配置管理

```javascript
// 拖拽排序
card.draggable = true;
card.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', card.dataset.id);
});

// 导出为 Markdown
function exportMarkdown() {
  const columns = document.querySelectorAll('.column');
  let md = '';
  columns.forEach(col => {
    md += `## ${col.dataset.name}\n\n`;
    col.querySelectorAll('.card').forEach(card => {
      md += `- ${card.querySelector('.title').textContent}\n`;
    });
  });
  navigator.clipboard.writeText(md);
}
```

> **💡 关键差异**：拖拽 + 实时预览 + 一键导出，把"看"变成"用"。这是 Markdown 完全无法触及的交互层次。

---

### 5.11 📊 仪表盘（Dashboard / Data Display）

**场景**：指标监控、KPI 展示、数据看板

```html
<div class="metric">
  <div class="value">12.5K</div>
  <div class="delta up">↑ 12%</div>
  <div class="sparkline">
    <div class="bar" style="height:40%"></div>
    <div class="bar" style="height:60%"></div>
    <div class="bar" style="height:80%"></div>
    <div class="bar" style="height:100%"></div>
  </div>
</div>
```

```css
.sparkline {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 40px;
}
.sparkline .bar {
  flex: 1;
  background: #D1CFC5;
  border-radius: 2px 2px 0 0;
}
.sparkline .bar:last-child { background: #D97757; }
```

> **💡 关键差异**：数字 + 趋势 + 状态三位一体，CSS 迷你图零依赖。比 Markdown 表格直观 10 倍。

---

## 6. v2.0 新特性：从"能看"到"好看"再到"好用"

v2.0 是一次重大升级，融合了三个优秀项目的精华：

### 6.1 美学方向框架（Aesthetic Direction Framework）

在写代码之前，先回答四个问题：
- **Purpose**：解决什么问题？谁用？
- **Tone**：选极端——极简、极繁、复古、自然、奢华、 playful...
- **Constraints**：技术限制（性能、可访问性）
- **Differentiation**：什么让人过目不忘？

**关键洞察**：大胆极繁和精致极简都可以，关键是**意图明确**，不是强度。

### 6.2 五维自评（5-Dimension Self-Critique）

 emit 前给自己打分（0-10），任何维度低于 3 就迭代：

| 维度 | 低分（0-4） | 高分（9-10） |
|------|------------|-------------|
| **哲学一致性** | 三种风格打架 | 每个元素都为同一个论点服务 |
| **视觉层级** | 所有内容都在喊 | 视线零摩擦移动 |
| **细节执行** | 胶带和绳子可见 | 杂志级水准 |
| **功能性** | 好看但没用 | 防御性工程 |
| **创新性** | 通用 AI 垃圾 | 多个值得偷学的点子 |

### 6.3 P0/P1/P2 质量检查清单

**P0 — 绝对不能发生**：
- ❌ 外部 CSS/JS 文件
- ❌ CDN 库
- ❌ `:root` 外的原始色值
- ❌ 紫色/紫罗兰渐变背景
- ❌ 表情符号作为功能图标
- ❌ 虚构指标
- ❌ 填充文本（"功能一/二"）
- ❌ 忘记 `data-od-id`
- ❌ 移动端断流

**P1 — 应该避免**：
- ❌ 文字墙
- ❌ 纯黑/纯白
- ❌ 过度动画
- ❌ 通用 AI 美学
- ❌ Inter/Roboto 作为展示字体

### 6.4 现代 CSS 技术

- **color-mix()**：派生色调，不增加令牌
- **clamp()**：流体排版
- **text-wrap: pretty/balance**：更美观的断行
- **scroll-snap**：幻灯片体验
- **CSS 网格**：复杂布局

### 6.5 演讲者模式（Presenter Mode）

如果用户提到"演讲"、"分享"、"speaker notes"，为每张幻灯片添加：

```html
<aside class="notes">
  150-300 字的演讲脚本...
</aside>
```

按 S 键打开演讲者视图（当前/下一张/脚本/计时器）。

---

## 7. v2.1：The Critique Revolution — 从"生成一次"到"生成、批判、精炼、收敛"

> **"Good design is not about getting it right the first time. It's about having the discipline to critique what you've made and make it better."**

v2.1 是一次哲学层面的升级。如果说 v2.0 解决了"生成漂亮的 HTML"的问题，v2.1 解决的则是"**生成之后怎么让它变得更好**"的问题。

### 7.1 核心变革：增强 Critique 系统

在 v2.0 中，我们有了五维自评——生成前给自己打分。但这只是一个起点。v2.1 从 **open-design-main** 项目中深度整合了一套完整的 Critique 引擎，让自我评判从"感觉还行"变成了"有据可依的量化分析"。

#### 雷达图可视化

不再是五个数字放在表格里。v2.1 的 Critique 输出包含一张 **SVG 雷达图**，六个维度（哲学一致性、视觉层级、细节执行、功能性、创新性、可访问性）在每个轴上展开，一眼就能看到设计的"形状"——哪里是尖峰、哪里是凹谷。

```
        哲学一致性
           /\
          /  \
    创新性    视觉层级
         |    |
    功能性    细节执行
          \  /
           \/
         可访问性
```

#### 乐队评分（Band Scoring, 0-10）

不再用"大概 6 分"这种模糊判断。每个维度的评分有明确的**乐队定义**：

| 乐队 | 分数 | 含义 |
|------|------|------|
| 🔴 Critical | 0-3 | 设计缺陷，必须修复 |
| 🟡 Acceptable | 4-6 | 基本达标，有提升空间 |
| 🟢 Strong | 7-8 | 专业水准，少量优化 |
| 🔵 Exceptional | 9-10 | 行业标杆，值得写进案例 |

#### 证据驱动（Evidence-Cited Reasoning）

每一个分数必须有**具体证据**——不是"我觉得布局不太好"，而是"第 3 张卡片在 920px 断点下文字溢出，违反了 P0 移动端规则"。

#### Keep / Fix / Quick-wins 三分法

Critique 输出不再是一堆问题列表，而是明确的行动指南：

- **🟢 Keep**：做对了什么，不要改。这是你的设计 DNA，是套系统的下限。
- **🔴 Fix**：必须改的问题。按 P0 > P1 > P2 排列，每个附带修改建议。
- **🟡 Quick-wins**：10 分钟内能提升一个档次的修改。高 ROI，低风险。

### 7.2 DevLoop：迭代式自我精炼

v2.1 最革命性的变化是 **DevLoop**——一个内建于 skill 的迭代自改进循环。

**传统流程**：
```
用户提需求 → AI 生成 HTML → 输出完毕
```

**v2.1 DevLoop 流程**：
```
用户提需求 → AI 生成 HTML → Self-Critique (雷达图 + 评分)
    ↓
  任何维度 < 4？
    ↓ YES
  应用 Fix 项 → 重新 Critique → 再次评分
    ↓
  所有维度 ≥ 4？
    ↓ YES
  输出最终版本 + Critique Report
```

这个循环不是无限的——它有一个明确的**收敛条件**：所有六个维度的评分都达到 4 分（Acceptable 乐队）以上。在实际使用中，大多数输出经过 **1-2 轮 DevLoop** 就能收敛。

**为什么是 4 分而不是 7 分？** 因为 4 分意味着"基本达标"——没有设计缺陷，每个维度都在及格线以上。这是质量的**底线**，不是天花板。如果你的场景需要更高标准，可以手动要求 skill 收敛到 7 分。

### 7.3 评分纪律：不平均、不膨胀

从 open-design-main 学来的最重要一课：**评分必须有纪律**。

v2.1 的 Critique 系统严格执行三条纪律：

1. **不平均**：六个维度各自独立评分。视觉层级 8 分不等于哲学一致性也能 8 分——每个维度有自己的判断标准。
2. **不膨胀**：7 分以上需要"例外级证据"。不是"看着还行"就能给 7 分，需要具体的、可验证的优秀之处。
3. **证据引用**：每一个分数必须附带具体的证据引用——指向页面中的某个元素、某行代码、某个交互行为。

这确保了 Critique 不是 self-congratulation，而是真正的 quality control。

### 7.4 新模式 #12：Live Artifact Dashboard

v2.1 从 open-design-main 引入了一个新的成熟模式：**Live Artifact Dashboard**。

这和传统的 Dashboard（模式 #11）有本质区别。传统仪表盘是静态快照——生成时的数据是什么样就显示什么样。Live Artifact Dashboard 是**活的数据看板**：

```
Template (HTML 结构)
    +
data.json (数据层，可独立刷新)
    +
artifact.json (来源追踪)
    =
Live Artifact (可刷新、可追溯的活看板)
```

**核心特性**：
- **数据与表现分离**：修改 data.json 后页面自动刷新，无需重新生成 HTML
- **来源追踪 (Provenance)**：每个数据点记录来源——谁提供的、什么时候更新的、置信度如何
- **可组合**：多个 Live Artifact 可以组合成一个更大的 Dashboard

这个模式特别适合：
- 需要定期更新的项目报表
- 多人协作的数据看板
- 数据来源多样的监控页面

### 7.5 新模式 #13：Frame Effects / Visual Moments

v2.1 的第二个新模式是 **Frame Effects**——一组纯 CSS 的"视觉时刻"，让页面在特定位置产生电影级的视觉冲击。

不是"到处都加点动画"，而是在**关键时刻**给出视觉惊喜：

| 效果 | 场景 | 技术 |
|------|------|------|
| **Glitch Title** | 页面标题、章节转折 | CSS `clip-path` + `@keyframes` |
| **Liquid Background** | Hero 区域、品牌页 | SVG `feTurbulence` + `feDisplacementMap` |
| **Light Leak** | 过渡动画、Loading | CSS `radial-gradient` + `mix-blend-mode` |
| **Morphing Blob** | 品牌装饰、Loading | CSS `border-radius` + `@keyframes` |
| **Scanlines** | 复古/赛博风格 | CSS `repeating-linear-gradient` |
| **Spotlight** | 强调重点区域 | CSS `radial-gradient` + 鼠标跟踪 |

Frame Effects 遵循"**一次一个亮点**"原则——每屏最多使用一个 Frame Effect，避免视觉过载。它们的存在不是为了炫技，而是为了**在读者可能走神的地方重新抓住注意力**。

```css
/* Glitch Title 示例 */
@keyframes glitch {
  0%   { clip-path: inset(40% 0 61% 0); transform: translate(-2px, 1px); }
  20%  { clip-path: inset(92% 0 1% 0);  transform: translate(1px, -1px); }
  40%  { clip-path: inset(43% 0 1% 0);  transform: translate(-1px, 2px); }
  60%  { clip-path: inset(25% 0 58% 0); transform: translate(2px, -1px); }
  80%  { clip-path: inset(54% 0 7% 0);  transform: translate(-1px, 1px); }
  100% { clip-path: inset贤(58% 0 43% 0); transform: translate(1px, -1px); }
}
```

### 7.6 PPT/Slide 模式增强

v2.1 的幻灯片模式从 **html-ppt** 项目中获得了大幅增强：

- **36 个预置主题**：从极简白到赛博朋克，每个主题包含完整的颜色方案、字体栈和装饰元素
- **31 种布局变体**：标题页、内容页、图片页、代码页、数据页...每种场景都有最优布局
- **15 个完整 Deck 模板**：项目汇报、技术分享、产品发布、学术答辩...开箱即用
- **27 种 CSS 动画**：入场动画、过渡动画、强调动画，全部纯 CSS
- **20 个 Canvas FX**：粒子背景、连线动画、波形可视化...用 Canvas 实现的背景特效
- **Presenter Mode**：按 S 键进入演讲者视图，显示当前页、下一页预览、演讲备注和计时器

### 7.7 哲学转变：从"生成一次"到"生成、批判、精炼、收敛"

v2.1 最深层的改变不是功能的增加，而是**工作哲学**的转变。

**v2.0 的假设**：AI 一次性生成高质量的 HTML 是可能的。
**v2.1 的认知**：真正的质量来自于**迭代**——生成、批判式审视、精确定位改进点、重复直到收敛。

这就像从"一次性快照摄影"到"暗房冲洗工艺"的进化。你不再期待第一张底片就是完美作品，而是把生成物当作**素材**，通过结构化的 Critique 和 DevLoop 打磨到最优状态。

这就是 v2.1 最核心的变革：**让 skill 拥有了自我精炼的能力**。

---

## 8. 实战：20 个真实办公场景全展示

| 场景 | 模式 | 输出 |
|------|------|------|
| 技术选型对比 | #1 并列对比 | 三列卡片，推荐项高亮 |
| PR 代码审查 | #2 代码审查 | 红绿 Diff + 严重性标签 |
| 系统架构说明 | #3 架构图 | SVG 模块图 + 交互提示 |
| 品牌色板展示 | #4 设计系统 | 色块网格 + 复制功能 |
| 项目周会汇报 | #5 幻灯片 | 全屏滚动 + 键盘导航 |
| 算法原理讲解 | #6 交互式讲解 | 折叠章节 + 实时演示 |
| 项目进度跟踪 | #7 状态报告 | 健康标签 + 迷你图 |
| CI/CD 流程 | #8 流程图 | 可点击节点 + 详情面板 |
| 博客技术配图 | #9 SVG 插图 | 矢量图 + 统一风格 |
| Bug 优先级排序 | #10 自定义编辑器 | 拖拽看板 + 导出 |
| 业务指标监控 | #11 仪表盘 | KPI 卡片 + 趋势图 |
| API 文档 | #6 交互式讲解 | 标签页代码 + 试玩区 |
| 事故复盘 | #7 状态报告 | 时间线 + 风险表 |
| 产品功能对比 | #1 并列对比 | 功能矩阵 + 勾选标记 |
| 数据库设计 | #3 架构图 | ER 图 + 关系标注 |
| 设计规范文档 | #4 设计系统 | 令牌表 + 组件变体 |
| 培训材料 | #5 幻灯片 | 演讲者备注 + 互动问答 |
| 配置界面 | #10 自定义编辑器 | 表单 + 实时预览 |
| 数据报告 | #11 仪表盘 | 多维度指标 + 筛选 |
| 流程优化建议 | #8 流程图 | 前后对比 + 效率数据 |
| 实时数据看板 | #12 Live Artifact | 可刷新 Dashboard + 来源追踪 |
| 品牌落地页 | #13 Frame Effects | 电影级视觉时刻 |

---

## 9. 安装与使用

### 9.1 OpenClaw 安装

```bash
# 复制到技能目录
cp -r html-skill-effectiveness ~/.qclaw/skills/

# 或使用 SkillHub
openclaw skill install html-effectiveness
```

### 9.2 Claude Code 安装

```bash
cp -r html-skill-effectiveness ~/.claude/skills/
```

### 9.3 使用方式

安装后，当 AI 检测到以下关键词时自动触发：

- "生成 HTML"
- "可视化"
- "对比"
- "仪表盘"
- "幻灯片"
- "流程图"
- "设计系统"
- "让好看一点"
- "优化布局"
- "critique 一下"
- "加个 frame effect"
- "做 live dashboard"

---

## 10. 最佳实践与避坑指南

### 10.1 设计原则

1. **先定调再动手** — 在写 HTML 之前，先确定美学方向
2. **六令牌原则** — 所有颜色来自 `:root` 的 6 个核心变量
3. **一次一个亮点** — 一个微动画、一个惊艳数据、一张好图
4. **移动端优先** — 所有网格在 ≤920px 自动折叠
5. **渐进式披露** — 用折叠、标签页控制信息密度
6. **Critique before emit** — 每次输出前跑一遍 Critique，低于 4 分就进 DevLoop

### 10.2 常见陷阱

| 陷阱 | 解决方案 |
|------|---------|
| 紫色渐变背景 | 用暖色调（赤陶、橄榄、燕麦） |
| 通用字体 | 选独特字体，Display 用衬线 |
| 过度动画 | 一个精心编排的入场 > scattered 微交互 |
| 文字墙 | 拆成卡片、网格、图表 |
| 虚构数据 | 标注占位符或删除 |
| 忘记移动端 | 所有网格必须响应式 |
| 评分膨胀 | 严格按乐队定义打分，7+ 需要例外级证据 |
| Frame Effect 滥用 | 每屏最多一个，关键时刻才用 |

### 10.3 性能优化

- CSS 优先，JS 最小化
- 使用 `transform` 和 `opacity` 做动画
- 图片用 SVG 或内联 base64
- 避免 heavy 动画库

---

## 11. 总结与获取

### 核心优势

✅ **13 种经过验证的模式** — 覆盖 90% 的 AI 输出场景
✅ **完整设计系统** — 颜色、字体、间距、圆角令牌
✅ **零依赖** — 单文件 HTML，浏览器直接打开
✅ **自包含** — 内联 CSS + JS，无需服务器
✅ **v2.0 升级** — 美学框架、质量检查、五维自评
✅ **v2.1 Critique Revolution** — 雷达图评分、DevLoop 迭代、Frame Effects、Live Artifact

### 获取方式

- **GitHub**: https://github.com/YardonYan/html-skill-effectiveness
- **License**: Apache 2.0（可商用、可修改）

### 贡献

欢迎提交 Issue 和 PR：
- 新的设计模式
- 设计系统改进
- 示例补充
- 文档翻译

---

> **最后的话**
>
> Markdown 是 AI 的舒适区，但 HTML 是 AI 的进化方向。
>
> 当 AI 学会用空间、颜色、交互来表达信息，它就不再是一个"文字生成器"，而是一个"视觉沟通者"。
>
> 而 v2.1 更进一步——当 AI 学会批判自己的输出、系统性地迭代求精，它就不再是一个"一次性生成器"，而是一个**持续精炼的工匠**。
>
> 这个 Skill 包，就是通往那个方向的桥梁。

---

## 9. v3.0：The Craft Discipline Revolution — 从"凭感觉检查"到"基于研究的可执行约束"

v2.1 解决了"如何批判"的问题——五维自评、雷达图、DevLoop 迭代。

但批判的前提是什么？批判的依据是什么？

v2.1 的五维自评（哲学一致性、视觉层级、细节执行、功能性、创新性）是一个好的框架，但它太抽象了。"哲学一致性 7 分"意味着什么？我该检查什么？证据在哪里？

v3.0 回答了这个问题——它引入了 **Craft Discipline System**（工艺纪律系统），一个基于一手研究的、可执行的、可检查的约束体系。

### 9.1 七条工艺规则

v3.0 从 OpenDesign 整合了七条工艺规则文件，每条都基于一手研究：

| # | 规则 | 核心贡献 | 研究来源 |
|---|---|---|---|
| 1 | **Anti-AI-Slop（反AI味）** | 七大罪 + 灵魂公式(80/20) | OpenDesign 实践提炼 |
| 2 | **Color（色彩）** | 四层调色板 + 强调色上限(2/屏) | 色彩理论 + WCAG |
| 3 | **Typography（排版）** | Letter-spacing 规则 + 三权重体系 | Bringhurst《排版风格要素》 |
| 4 | **Typography Hierarchy（排版层级）** | 五向量 + 三级模型 | 排版层级理论 |
| 5 | **Animation Discipline（动画纪律）** | 时长阈值 + 曲线vs弹簧 + 3个神话纠正 | Tversky 2002 + M3 + Carbon |
| 6 | **Accessibility Baseline（可访问性底线）** | WCAG法律底线 + ARIA纪律 | WCAG 2.2 + WebAIM 2026 + ARIA APG |
| 7 | **Laws of UX（UX法则）** | 26条可执行法则 | Hick/Miller/Fitts/Jakob 等一手研究 |

每条规则都包含：
- **P0 约束**：必须通过，否则不 emit
- **证据引用**：每条规则都引用具体研究来源
- **可检查性**：设计为可被 linter 自动检查

### 9.2 Letter-Spacing：最被低估的规则

让我举一个具体的例子——**Letter-Spacing（字距）**。

这是 AI 生成设计中最常见、最容易被忽略、但最能区分"业余"和"专业"的规则：

| 上下文 | Letter-Spacing |
|---|---|
| 正文（14-18px） | `0`（默认） |
| 小字（11-13px） | `0.01em` 到 `0.02em`（正） |
| UI 标签和按钮 | `0.02em` |
| **ALL CAPS** | **`0.06em` 到 `0.1em`（必须）** |
| 标题 32px+ | `-0.01em` 到 `-0.02em`（负） |
| Display 48px+ | `-0.02em` 到 `-0.03em`（负） |

两条关键规则：
1. **ALL CAPS 必须有 ≥0.06em 的正字距** —— 否则字母间距太紧，看起来业余
2. **Display 文字必须有负字距** —— 否则大号文字显得松散、无力

为什么是 `0.06em`？这不是拍脑袋——它来自 Bringhurst《排版风格要素》§3.2.7：大写字母的字距应为 em 的 5-10%。现代屏幕实践将下限取整为 0.06em。

v3.0 将这两条规则写入 P0 —— **ALL CAPS 无字距 = 不 emit**。

### 9.3 动画纪律：三个神话纠正

另一个例子——**Animation Discipline（动画纪律）**。

AI 生成的设计经常引用一些"设计法则"，但很多是民间传说。v3.0 纠正了三个：

| 神话 | 事实 | 来源 |
|---|---|---|
| "Skeleton screens feel 11% faster" | Harrison/Yeo/Hudson CHI 2010 测量的是 **backwards-decelerating ribbed determinate progress bars**，不是 skeleton | 原论文 |
| "Doherty Threshold = 400ms" | 1982 论文不包含"400"。最低测量阈值 = 300ms | 原论文 |
| "M2 标准曲线 = M3 标准曲线" | M3 标准是 `cubic-bezier(0.2,0,0,1)`。M2 的 `cubic-bezier(0.4,0,0.2,1)` 在 M3 中叫 `legacy` | Material 3 文档 |

v3.0 的动画规则基于一手研究：
- **150ms 默认时长**：Material 3 `short3`、IBM Carbon `moderate-01`、Shopify Polaris `150`、Tailwind default 的收敛值
- **动画仅用于空间/时间/状态转换**：Tversky/Morrison/Bétrancourt 2002 元分析的结论——动画不比静态更适合教学复杂系统
- **`prefers-reduced-motion`**：WebKit 2017 引入，W3C MQ5 允许 UA 或作者完全移除动画

### 9.4 可访问性：法律底线因司法管辖区而异

这是最被忽略的事实——**WCAG 的法律底线因司法管辖区而异**：

| 司法管辖区 | 标准 | 参考 |
|---|---|---|
| **EU (EAA, 2025-06-28 生效)** | **WCAG 2.1 AA** | EN 301 549 v3.2.1 |
| **US 公共部门 (ADA Title II 2024)** | **WCAG 2.1 AA** | 2027-04-26 (≥50k 人口) |
| **US 联邦采购 (Section 508)** | **WCAG 2.0 AA** | Revised 508 Standards |
| **US 私营部门 (ADA Title III)** | 逐案处理；**WCAG 2.1 AA** 事实标准 | 无联邦法规 |

**实用规则**：目标 **WCAG 2.2 AA** 作为工作上限。它同时满足 EU 和 US 的法律底线。

另一个反直觉的数据——**ARIA 使用越多，错误越多**：

WebAIM Million 2026：ARIA 页面平均 **59.1 错误** vs 非 ARIA 页面 **42 错误**。差距从 2025 年的 30（57 vs 27）缩小到 17，但 ARIA 正确率仍落后于使用率。

v3.0 的 ARIA 纪律：
1. 原生 HTML 元素优先
2. 原生元素 + 自定义视觉
3. APG 模式
4. 最近 APG 模式 + 文档化偏差（最后手段）

**永远不要发明 ARIA。**

### 9.5 UX 法则：26 条可执行

v3.0 精选了 26 条最实用的 UX 法则，每条都有明确的执行指令：

**格式塔法则（感知）**：
- **接近性**：相关项目间距 ≤8px，无关项目 ≥24px
- **相似性**：同类型 = 同视觉处理
- **连续性**：沿连续线/曲线对齐
- **闭合性**：用部分轮廓，让眼睛完成
- **Prägnanz**：更简单的排列胜出

**决策法则**：
- **Hick 定律**：>7 选项 → 搜索/过滤/分组为 3-5 类
- **选择过载**：主要操作 ≤3 个
- **帕累托**：让 20% 显眼，把 80% 埋进菜单

**记忆法则**：
- **Miller/Cowan**：工作记忆 4±1 项（不是 Miller 的 7±2，Cowan 2001 修正）
- **Peak-End**：让峰值和结尾刻意设计
- **Zeigarnik**：多步骤流程显示进度

**交互法则**：
- **Fitts 定律**：主要操作 ≥44px，靠近可能的光标位置
- **Jakob 定律**：先匹配熟悉模式，创新在基线之后

### 9.6 状态覆盖：AI 最常见的缺失

AI 生成 UI 最常见的问题——**只画"数据存在"的状态**。

v3.0 要求每个交互表面必须渲染 **5 种状态**：

| 状态 | 触发条件 | 必须包含 |
|---|---|---|
| **Loading** | 数据在传输中 | Skeleton/spinner + 15s "耗时较长" 回退 |
| **Empty** | 无记录 | 标题 + 解释 + 主 CTA（不是空白） |
| **Error** | 获取失败/验证拒绝 | 发生了什么 + 为什么 + 怎么办（保留用户输入） |
| **Populated** | 数据存在 | 你实际设计的那个状态 |
| **Edge** | 极端情况 | 不崩溃的布局 |

**错误状态必须回答三个问题**（按顺序）：
1. 发生了什么 —— "您的卡被拒绝。" 不是 "出了问题。"
2. 为什么（如果可知）—— "余额不足。"
3. 用户能做什么 —— 重试按钮、替代路径、支持链接

### 9.7 表单验证：八状态机

v3.0 引入了完整的表单验证状态机：

| 状态 | 含义 | UI |
|---|---|---|
| `pristine` | 用户未交互 | 无错误，无绿勾 |
| `dirty` | 用户已输入但未提交 | 无错误 |
| `touched` | 用户已 blur 至少一次 | 字段级约束运行 |
| `invalid-after-touched` | blur 后约束失败 | 显示错误 |
| `invalid-after-submit` | 提交尝试，字段仍无效 | 同上 + 焦点管理 |
| `recovering` | 用户编辑已无效字段 | 在 `input` 事件重验 |
| `submitting` | 动作在传输中 | 禁用提交，礼貌 live region |
| `server-error` | 服务器返回字段错误 | 使用服务器消息 |

**四条验证时序规则**：
1. **首次 blur 后编辑**运行字段级约束 —— 不是 focus，不是首次击键，不是每次击键
2. **一旦无效，切换到 `input` 事件重验** —— 错误在输入变有效时立即清除
3. **提交时**运行 schema 解析 —— 焦点移到错误摘要或第一个无效字段
4. **异步检查分两路** —— 后台预检 debounce 250-500ms；权威服务器验证在提交路径等待响应

CSS 快捷方式：样式基于 `:user-invalid`，不是 `:invalid`。`:user-invalid` 仅在用户提交或 blur 后输入无效时匹配。

### 9.8 P0 增强：从 10 条到 15 条

v3.0 的 P0 反模式列表从 10 条增至 15 条：

新增 5 条：
1. **ALL CAPS 无 `letter-spacing` ≥ `0.06em`** —— 拥挤的大写 = 业余
2. **Display 文字 (≥32px) 无负 tracking** —— 松散的 display = 无力
3. **Serif 约束下用 sans-serif 做展示** —— `h1`/`h2` 必须用 `var(--font-display)`
4. **圆角卡片 + 彩色左边框** —— 典型的 "AI dashboard tile"
5. **`:invalid` 不用 `:user-invalid`** —— 页面加载就显示红框 = 未测试验证

### 9.9 v3.0 的意义

v3.0 的意义不在于"加了更多规则"——而在于**规则的来源变了**。

v2.1 的规则是"经验总结"——"不要用紫色渐变"、"不要用 emoji 做图标"。这些规则是对的，但它们没有根基。

v3.0 的规则是"研究提炼"——每条规则都引用一手研究：
- Letter-spacing 来自 Bringhurst 的《排版风格要素》
- 动画纪律来自 Tversky 2002 元分析、Material 3、IBM Carbon
- 可访问性底线来自 WCAG 2.2、ADA Title II、EN 301 549
- UX 法则来自 Hick、Miller、Fitts、Jakob 等一手论文

这带来的变化是：**规则不再是"我觉得"，而是"研究显示"**。

当 AI 说"这个设计违反了 letter-spacing 规则"时，它不是在表达偏好——它是在引用 Bringhurst。当它说"这个动画时长超过了 500ms 阈值"时，它是在引用 Tversky 的元分析。

这就是 Craft Discipline（工艺纪律）——**可执行的、可检查的、基于研究的约束**。

---

## 10. 总结与获取

### 10.1 这个 Skill 包解决了什么问题？

| 问题 | 解决方案 |
|---|---|
| AI 默认输出 Markdown，不适合空间表达 | 用 HTML 替代 Markdown，提供 13 种设计模式 |
| AI 生成的 HTML 缺乏设计系统 | 6 个核心令牌 + 派生规则 + 字体/间距/响应式规则 |
| AI 生成的 HTML 缺乏质量检查 | P0/P1/P2 反模式清单 + 5 维自评 + DevLoop 迭代 |
| AI 生成的 HTML "AI 味"太重 | 7 条工艺规则 + 15 条 P0 约束 + 灵魂公式 |
| AI 生成的 HTML 可访问性差 | WCAG 法律底线 + ARIA 纪律 + 焦点/对比度规则 |
| AI 生成的 HTML 状态覆盖不全 | 5 必须状态 + 表单验证状态机 |

### 10.2 如何获取

**GitHub**: [YardonYan/html-effectiveness](https://github.com/YardonYan/html-effectiveness)

**安装到 OpenClaw**:
```bash
cp -r html-skill-effectiveness ~/.qclaw/skills/
```

**安装到 Claude Code**:
```bash
cp -r html-skill-effectiveness ~/.claude/skills/
```

### 10.3 版本历史

- **v3.0** (2026-05-21): Craft Discipline Revolution — 7 条工艺规则 + 状态覆盖 + 表单验证
- **v2.1** (2026-05-21): Critique Revolution — 五维自评 + DevLoop + 2 新模式
- **v2.0** (2026-05-20): 设计系统整合 — 6 核心令牌 + 11 模式 + P0/P1/P2
- **v1.0** (2026-05): 原版 html-effectiveness

---

*本文基于 html-effectiveness v3.0，融合了 [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) by Anthropic、[open-design](https://github.com/opendesign) by OpenDesign（含 7 条 craft rules + state-coverage + form-validation）以及 html-ppt 的 36 主题演示系统。所有规则均基于一手研究，引用具体来源。*