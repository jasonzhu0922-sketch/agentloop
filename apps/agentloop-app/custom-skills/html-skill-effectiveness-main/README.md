# html-skill-effectiveness / HTML 效能工艺

> **Trade documents people skim for documents people actually read.**
> **把人们略读的文档变成人们真正会阅读的文档。**

AI is great at writing Markdown. But Markdown is linear and limited — tables and bold text only go so far. This skill teaches AI to output **real HTML pages** instead: side-by-side comparisons that make trade-offs obvious, architecture diagrams you can zoom and click, slide decks with speaker notes, dashboards with live charts.

What makes this different from "make me an HTML page"? Three things: **Craft Rules** — 7 hard rules that block AI slop before it reaches you (no purple gradients, no filler text, no fake numbers, real accessibility compliance); **Self-Critique** — the AI grades its own work on 5 dimensions and iterates until quality passes; **Zero Dependencies** — every artifact is a single HTML file, inline everything, opens in any browser with nothing to install.

Compatible with any AI agent that supports skill files — Claude Code, OpenClaw, Cursor, Windsurf, and more. 13 battle-tested patterns. v3.0.

---

AI 很擅长写 Markdown。但 Markdown 是线性的、能力有限——表格和加粗文字的表达力就到这了。这个技能教 AI 输出**真正的 HTML 页面**：让权衡一目了然的并排对比、可缩放点击的架构图、带演讲者备注的幻灯片、实时更新的数据仪表盘。

和"帮我写个 HTML 页面"有什么不同？三点：**工艺规则**——7 条硬性规则在 AI 输出前拦截所有 AI 味道（没有紫色渐变、没有假文案、没有虚构数字、强制执行可访问性标准）；**自我评审**——AI 先给自己打分，5 个维度，不及格就回去改，直到通过了才给你看；**零依赖**——每个工件就是单个 HTML 文件，全内联，任何浏览器直接打开，无需装任何东西。

兼容任何支持 skill 文件的 AI 助手——Claude Code、OpenClaw、Cursor、Windsurf 等均可使用。13 种实战验证的模式。v3.0。

[![GitHub](https://img.shields.io/badge/GitHub-YardonYan%2Fhtml--skill--effectiveness-181717?logo=github)](https://github.com/YardonYan/html-skill-effectiveness)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE.txt)

---

## Architecture Overview / 架构总览

```mermaid
graph TB
    subgraph Input["📥 Input Layer"]
        U[User Intent / 用户意图]
        P[Pattern Selection / 模式选择]
        KN[VARIANCE · MOTION · DENSITY / 三旋钮调参]
    end

    subgraph Core["⚙️ Core Engine"]
        DS[Design System / 设计系统<br/>6 Tokens]
        PC[Pattern Catalog / 模式目录<br/>13 Patterns]
        WF[Workflow Engine / 工作流引擎]
    end

    subgraph Craft["🛡️ Craft Discipline v3.0"]
        CR[7 Craft Rules / 7条工艺规则]
        SC[State Coverage / 状态覆盖<br/>5 States + 8 Input States]
        FV[Form Validation / 表单验证]
    end

    subgraph Critique["🔍 Critique System"]
        C5[5-Dimension Self-Critique / 五维评审]
        RS[Radar Chart / 雷达图]
        DL[DevLoop / 迭代优化]
    end

    subgraph Output["📤 Output"]
        H[Single-File HTML / 零依赖单文件]
        Q[Quality Score ≥ 4 / 质量分 ≥ 4]
    end

    U --> P
    U --> KN
    P --> DS & PC
    DS & PC --> WF
    WF --> CR
    CR --> SC & FV
    SC & FV --> C5
    C5 --> RS --> DL
    DL -->|Score < 4| CR
    DL -->|Score ≥ 4| H
    H --> Q

    style Input fill:#fafaf7,stroke:#e8e5df
    style Core fill:#ffffff,stroke:#c96442
    style Craft fill:#ffe8e0,stroke:#b04a3f
    style Critique fill:#fff5f0,stroke:#c96442
    style Output fill:#f0f7ec,stroke:#788c5d
```

---

## Workflow Pipeline / 工作流管道

```mermaid
flowchart LR
    S0[Step 0 / Pre-flight / 预飞检查] --> S1
    S1[Step 1 / Aesthetic Direction / 美学方向<br/>+ Tuning Knobs] --> S2
    S2[Step 2 / Write Artifact / 编写工件<br/>+ Craft Rules Check] --> S3
    S3[Step 3 / Self-Critique / 五维自评] --> S4{Score ≥ 4?}
    S4 -->|No| S5[DevLoop / 迭代修复]
    S5 --> S2
    S4 -->|Yes| S6[Step 4 / Emit / 输出]

    style S0 fill:#fafaf7,stroke:#e8e5df
    style S1 fill:#ffffff,stroke:#c96442
    style S2 fill:#ffffff,stroke:#c96442
    style S3 fill:#fff5f0,stroke:#c96442
    style S4 fill:#fff5f0,stroke:#c96442
    style S5 fill:#fdf2f0,stroke:#b04a3f
    style S6 fill:#f0f7ec,stroke:#788c5d
```

---

## Critique System Architecture / 评审系统架构

```mermaid
graph LR
    subgraph Dimensions["5 Dimensions / 五个维度"]
        D1[Philosophy Consistency / 哲学一致性]
        D2[Visual Hierarchy / 视觉层级]
        D3[Detail Execution / 细节执行]
        D4[Functionality / 功能性]
        D5[Innovation / 创新性]
    end

    subgraph Scoring["Band Scoring / 波段评分"]
        B1[0-4: Broken / 破碎]
        B2[5-6: Functional / 可用]
        B3[7-8: Strong / 强]
        B4[9-10: Exceptional / 卓越]
    end

    subgraph Action["Action Categories / 动作分类"]
        K[Keep / 保留]
        F[Fix / 修复]
        QW[Quick-wins / 快速优化]
    end

    D1 & D2 & D3 & D4 & D5 --> Scoring
    Scoring --> Action

    style Dimensions fill:#fafaf7,stroke:#e8e5df
    style Scoring fill:#ffffff,stroke:#c96442
    style Action fill:#f0f7ec,stroke:#788c5d
```

---

## Pattern Catalog Map / 模式目录图

```mermaid
mindmap
  root((Pattern Catalog<br/>模式目录))
    Comparison / 对比
      1. Side-by-Side
      2. Annotated Diff
    Diagram / 图表
      3. Module Map
      8. Flowchart
      9. SVG Illustration
    Document / 文档
      6. Interactive Explainer
      7. Status Report
    Presentation / 演示
      5. Slide Deck
        36 themes
        Canvas FX
    System / 系统
      4. Living Design System
    Interactive / 交互
      10. Custom Editor
      11. Dashboard
      12. Live Artifact Dashboard
      13. Frame Effects
```

---

## What This Is / 这是什么

AI defaults to Markdown. Markdown is linear text — great for reading sequentially, terrible for:

AI 默认使用 Markdown。Markdown 是线性文本——适合顺序阅读，但不适合：

- Side-by-side comparisons / 并排对比
- Architecture diagrams / 架构图
- Interactive explainers / 交互式讲解
- Data dashboards / 数据仪表盘
- Slide decks / 幻灯片
- Code diffs with annotations / 带注释的代码差异

**HTML can do all of these.** This skill teaches AI how to generate them well.

**HTML 可以做到所有这些。** 这个技能教会 AI 如何生成高质量的 HTML 输出。

Every artifact is / 每个工件：
- **Single file / 单文件** — inline CSS and JavaScript, zero external dependencies / 内联 CSS 和 JavaScript，零外部依赖
- **Self-contained / 自包含** — open in any browser, no server needed / 在任何浏览器中打开，无需服务器
- **Visually polished / 视觉精美** — design system, typography, spacing, color tokens / 设计系统、字体、间距、色彩令牌
- **Pattern-based / 基于模式** — 13 proven patterns for common AI output scenarios / 13 种经过验证的模式，覆盖常见 AI 输出场景

---

## Changelog / 更新日志

### v3.0 (2026-06-29) — Craft Discipline Revolution / 工艺纪律革命

**新增：**
- 7 条可检查工艺规则（Anti-AI-Slop / Color / Typography / Typography Hierarchy / Animation / Accessibility / UX Laws），全部基于一手研究并引用来源
- 状态覆盖契约（5 种必须 UI 状态：Loading / Empty / Error / Populated / Edge）
- 表单验证状态机（8 种输入状态 + 4 条验证时序规则）
- 三旋钮调参接口（VARIANCE / MOTION / DENSITY），用户可通过参数微调输出风格
- 美学方向品牌参照锚定，每个方向附带 1-2 个真实品牌参考
- 适用边界声明，明确 Skill 不适用于需要身份验证/支付/后端逻辑的场景

**优化：**
- SKILL.md 结构瘦身（1421 行 → ~400 行），核心规则自包含，详细资料移至 references/
- P0 反模式从 10 条增至 15 条（新增：大写字母字距、展示文字负字距、serif 标题一致性、圆角卡片+彩色左边框、:user-invalid）
- P1 反模式新增 6 条（标准模板、外部占位图 CDN、强调色使用频率、装饰动画、outline 移除、过早验证）
- Accent Discipline 规则精确化：从"每屏 2 次"改为"每个视觉区域 2 次"
- Pattern Catalog 增加内联定义，AI 无需跳转 references 即可理解模式意图
- Craft Rule 3 (Typography) 增加 letter-spacing 强制规则和 three-weight 系统
- Craft Rule 5 (Animation) 增加 duration 阈值表、curve vs spring 选择、动画决策树
- Craft Rule 6 (Accessibility) 增加 WCAG 法律底线（EU/US 司法管辖区）、ARIA 纪律、TTT 注解
- Craft Rule 7 (Laws of UX) 从 26 条一手研究中提炼可执行指令
- 动画反常识修正（Skeleton 11% 更快 = FALSE，Doherty 400ms = FALSE，M3 curve 标注错误）

**修复：**
- 6 令牌哲学与 16 色完整板冲突 → 统一为 6 令牌，完整板移至 references/palette-examples.md
- Frontend Aesthetics Guidelines 与 Craft Rules 内容重复 → 删除重复段落
- 模式之间缺少组合指导 → Decision Flow 增加跨模式组合规则

---

## Installation / 安装

### Quick Start (any platform)

```bash
git clone https://github.com/YardonYan/html-skill-effectiveness.git
```

Or download the latest ZIP from [Releases](https://github.com/YardonYan/html-skill-effectiveness/releases).

### For OpenClaw

```bash
# Copy to your workspace skills directory
cp -r html-skill-effectiveness ~/.qclaw/skills/
```

Or use the SkillHub / 或使用 SkillHub：
```bash
openclaw skill install html-effectiveness
```

### For Claude Code

```bash
cp -r html-skill-effectiveness ~/.claude/skills/
```

### For Cursor / other AI tools

This is a single `SKILL.md` file — copy or symlink it wherever your tool loads rules. For example:

```bash
# Cursor: copy into .cursorrules or Rules directory
cp SKILL.md ~/.cursorrules/html-effectiveness.md
```

Any AI coding assistant that reads markdown instruction files can use this skill — just point it at `SKILL.md`.

---

## Live Demos / 在线演示

Click to see rendered pages / 点击查看渲染效果：

| Demo | Description / 描述 |
|------|-----|
| [Full Pattern Showcase / 完整模式展示](https://raw.githack.com/YardonYan/html-skill-effectiveness/main/demo.html) | 13 patterns + v3.0 State Coverage, Form Validation, Tuning Knobs |
| [Pattern Showcase (EN)](https://raw.githack.com/YardonYan/html-skill-effectiveness/main/indexxxxxxx_en.html) | English pattern showcase with v3.0 features |
| [Pattern Showcase (ZH)](https://raw.githack.com/YardonYan/html-skill-effectiveness/main/indexxxxxxx_zh.html) | 中文模式展示 + v3.0 特性 |
| [v2.1 Demo (Archived)](https://raw.githack.com/YardonYan/html-skill-effectiveness/main/test-v21-demo.html) | v2.1 Frame Effects + Live Dashboard archive |

> Note: Links use raw.githack.com to render HTML directly. May take a few seconds on first load.
> 说明：链接使用 raw.githack.com 直接渲染 HTML，首次加载可能需要几秒。

---

## Pattern Catalog / 模式目录

> **Craft Rules apply to ALL patterns.** Before emitting any pattern, run through the Craft Rules checklist. No pattern is exempt from P0 rules.
> **工艺规则适用于所有模式。** 在输出任何模式前，必须通过工艺规则检查清单。无模式可豁免 P0 规则。

| # | Pattern / 模式 | Use For / 用于 |
|---|---------|---------|
| 1 | **Side-by-Side Comparison / 并排对比** | Tech choices, design options, trade-offs / 技术选型、设计选项、权衡 |
| 2 | **Annotated Diff / 代码审查** | PR reviews, code changes, before/after / PR 评审、代码变更、前后对比 |
| 3 | **Module Map / 模块地图** | Architecture diagrams, data flow / 架构图、数据流 |
| 4 | **Living Design System / 设计系统** | Color palettes, typography, component catalogs / 色板、字体、组件目录 |
| 5 | **Slide Deck / 幻灯片** | Presentations, walkthroughs, demos / 演示、讲解、演示 |
| 6 | **Interactive Explainer / 交互式讲解** | Teaching concepts, documentation / 教学概念、文档 |
| 7 | **Status Report / 状态报告** | Weekly updates, incident reports / 周报、事故报告 |
| 8 | **Flowchart / 流程图** | Pipelines, decision trees, workflows / 流水线、决策树、工作流 |
| 9 | **SVG Illustration / SVG 插图** | Blog diagrams, figures, icons / 博客图表、图形、图标 |
| 10 | **Custom Editor / 自定义编辑器** | Triage boards, prompt tuning, configuration / 看板、提示调优、配置 |
| 11 | **Dashboard / 仪表盘** | Metrics, KPIs, monitoring views / 指标、KPI、监控视图 |
| 12 | **Live Artifact Dashboard / 实时工件仪表盘** | Refreshable dashboards with template+data / 可刷新仪表盘，模板+数据架构 |
| 13 | **Frame Effects / 视觉特效** | Cinematic visual moments / 电影级视觉时刻 |

---

## Design System / 设计系统

### Core Tokens (6 variables) / 核心令牌（6 个变量）

```css
:root {
  --bg:      #fafaf7;   /* page background / 页面背景 */
  --surface: #ffffff;   /* cards, panels / 卡片、面板 */
  --fg:      #1a1916;   /* primary text / 主文本 */
  --muted:   #6b6964;   /* secondary text / 次要文本 */
  --border:  #e8e5df;   /* dividers / 分隔线 */
  --accent:  #c96442;   /* one accent, max 2× per visual region / 强调色，每个视觉区域最多 2 次 */
}
```

Everything else derives from these via `color-mix()`. No raw hex outside `:root`.

其他所有颜色都通过 `color-mix()` 派生。`:root` 外禁止使用原始十六进制色值。

### Typography / 字体

| Element / 元素 | Font / 字体 | Size / 大小 |
|---------|------|------|
| H1 | Display serif | clamp(44px, 6vw, 76px) |
| H2 | Display serif | clamp(32px, 4vw, 48px) |
| Body / 正文 | System sans | 16px |
| Code / 代码 | Mono | 13px |
| Eyebrow / 标签 | Mono | 11px, uppercase |

**Use system font fallback chains.** Prioritize built-in system fonts over external Google Fonts.

**优先使用系统字体 fallback 链。** 优先使用系统内置字体而非外部 Google 字体。

---

## Workflow / 工作流

### Step 0 — Pre-flight / 预飞检查
1. Read SKILL.md end-to-end / 从头到尾阅读 SKILL.md
2. Understand user's intent / 理解用户意图
3. Map to Pattern Catalog / 映射到模式目录
4. Plan section list / 规划章节列表

### Step 1 — Choose Aesthetic Direction / 选择美学方向
- Purpose, Tone, Constraints, Differentiation / 目的、调性、约束、差异化
- **Tuning Knobs / 三旋钮调参**: VARIANCE (1-10) / MOTION (1-10) / DENSITY (1-10), default 5
- **Brand Anchors / 品牌参照**: Each direction has 1-2 real brand references

### Step 2 — Write the Artifact / 编写工件
- Copy HTML Structure Template / 复制 HTML 结构模板
- Define 6 tokens in `:root` / 在 `:root` 中定义 6 令牌
- Build sections from Pattern Catalog / 从模式目录构建章节
- Run Craft Rules check / 运行工艺规则检查

### Step 3 — Critique / 评审
- Run 5-Dimension Self-Critique / 运行五维自评
- Band scoring (0-10) per dimension / 每维度波段评分（0-10）
- Generate Keep/Fix/Quick-wins report / 生成 Keep/Fix/Quick-wins 报告

### Step 4 — DevLoop / 迭代优化
- Apply Keep items / 保留 Keep 项
- Address Fix items / 处理 Fix 项
- Re-score after fixes / 修复后重新评分
- Max 3 iterations / 最多 3 轮

### Step 5 — Emit / 输出
```
<artifact identifier="slug" type="text/html" title="Title">
<!doctype html>
<html>...</html>
</artifact>
```

---

## Quality Standards / 质量标准

### P0 — Must Never Happen (15 items) / 绝对不能发生（15 条）
1. No external CSS/JS files / 禁止外部 CSS/JS 文件
2. No CDN libraries / 禁止 CDN 库
3. No raw hex outside `:root` / `:root` 外禁止原始十六进制
4. No purple/violet/indigo gradient backgrounds / 禁止紫色/紫罗兰/靛蓝渐变背景
5. No default Tailwind indigo (`#6366f1`, `#8b5cf6`) as accent / 禁止默认 Tailwind 靛蓝作强调色
6. No emoji as feature icons / 禁止用表情符号作为功能图标
7. No invented metrics / 禁止虚构指标
8. No filler copy / 禁止填充文本
9. `data-od-id` on every `<section>` / 每个 `<section>` 必须有 `data-od-id`
10. Mobile reflow works (≤920px) / 移动端重排正常（≤920px）
11. ALL CAPS must have `letter-spacing` ≥ `0.06em` / 大写字母必须有字距
12. Display text (≥32px) must have negative tracking / 展示文字必须有负字距
13. Display text must use `var(--font-display)`, not system-sans / 展示文字必须使用 `var(--font-display)`
14. No rounded card + colored left-border accent / 禁止圆角卡片+彩色左边框
15. Style off `:user-invalid`, not `:invalid` / 用 `:user-invalid` 而非 `:invalid`

### P1 — Should Avoid (10 items) / 应该避免（10 条）
- Walls of text / 文字墙
- Pure black/white / 纯黑/纯白
- Over-animation (max 500ms non-cross-screen) / 过度动画
- Generic AI aesthetics / 通用 AI 美学
- Inter/Roboto as display fonts / Inter/Roboto 作为展示字体
- Standard Hero→Features→Pricing→FAQ→CTA without variation / 无变化的标准模板
- External placeholder image CDNs / 外部占位图 CDN
- `var(--accent)` used 6+ times (cap: 2 per visual region) / 强调色每个视觉区域超过 2 次
- `outline: none` without replacement / 无替代的 focus outline 移除
- Validate on first keystroke / 首次击键就验证

### Scoring Discipline / 评分纪律
- **No averaging / 禁止平均**: each dimension scored independently / 每维度独立评分
- **No inflation / 禁止膨胀**: 7+ requires exceptional evidence / 7+ 需要非凡证据
- **Evidence-cited / 基于证据**: every score must cite specific observations / 每分必须引用具体观察

---

## File Structure / 文件结构

```
html-skill-effectiveness/
├── SKILL.md                    # Core skill definition (v3.0) / 核心技能定义
├── README.md                   # This file / 本文件
├── LICENSE.txt                 # Apache 2.0
├── BLOG.md                     # Detailed blog post / 详细博客文章
├── INTEGRATION_SUMMARY.md      # Version integration history / 版本整合历史
├── RELEASE-v3.0.md             # v3.0 release notes / v3.0 发布说明
├── indexxxxxxx_en.html         # English showcase / 英文展示页
├── indexxxxxxx_zh.html         # Chinese showcase / 中文展示页
└── references/
    ├── pattern-examples.md     # Code snippets by pattern / 按模式的代码片段
    ├── complete-examples.md    # Full HTML examples / 完整 HTML 示例
    ├── critique-guide.md       # Complete critique system guide / 完整评审系统指南
    ├── frame-effects.md        # Frame Effects pattern reference / 视觉特效模式参考
    ├── craft-rules-reference.md # Craft rules quick reference / 工艺规则快速参考
    ├── palette-examples.md     # 16色完整板 + 4替代方案 / 16-color palette + 4 alternatives
    ├── style-recipes.md        # 美学方向×品牌参照映射表 / Aesthetic direction × brand reference map
    ├── presenter-mode.md       # BroadcastChannel 双窗口演讲者模式 / Dual-window presenter mode
    ├── ux-laws-reference.md    # 26条UX法则完整版 / Complete 26 UX laws
    ├── accessibility-detail.md # WCAG合规细节 / WCAG compliance details
    └── device-frames.md        # CSS设备外框代码 / CSS device frame code
```

---

## Example Prompts / 示例提示

- "Generate a status report as HTML" / "生成 HTML 状态报告"
- "Make this comparison visual with HTML" / "用 HTML 让这个对比可视化"
- "Create an interactive explainer for [concept]" / "为 [概念] 创建交互式讲解"
- "Build a slide deck about [topic]" / "制作关于 [主题] 的幻灯片"
- "Design a triage board for these tickets" / "为这些工单设计看板"
- "Draw a flowchart of this process" / "绘制这个流程的流程图"
- "Show me component variants in HTML" / "在 HTML 中展示组件变体"
- "Make this HTML prettier / more professional" / "让这个 HTML 更美观/更专业"
- "Create a dashboard for [metrics] --variance=7 --motion=4 --density=5" / "为 [指标] 创建仪表盘"
- "Make a presentation with speaker notes" / "制作带演讲者备注的演示"
- "Critique this HTML output and suggest improvements" / "评审这个 HTML 输出并建议改进"
- "Add a live artifact dashboard with refreshable data" / "添加带可刷新数据的实时仪表盘"
- "Apply frame effects to make this page cinematic" / "应用视觉特效让页面更具电影感"

---

## Credits / 致谢

- **Original concept / 原版概念**: [The Unreasonable Effectiveness of HTML](https://github.com/ThariqS/html-effectiveness) by Thariq Shihipar
- **Aesthetic philosophy / 美学哲学**: [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) by Anthropic
- **Craft discipline system / 工艺纪律系统**: [open-design](https://github.com/opendesign) by OpenDesign — anti-ai-slop, color, typography, typography-hierarchy, animation-discipline, accessibility-baseline, laws-of-ux, state-coverage, form-validation craft rules / 反AI味、色彩、排版、排版层级、动画纪律、可访问性底线、UX法则、状态覆盖、表单验证工艺规则
- **PPT/Slide enhancement / PPT/幻灯片增强**: [html-ppt](https://github.com/opendesign) — 36 themes, 31 layouts, canvas FX / 36 套主题、31 种布局、Canvas FX
- **Integration & enhancement / 整合与增强**: [Yardon](https://github.com/YardonYan)

---

## License / 许可证

Apache 2.0 — see [LICENSE.txt](LICENSE.txt)
