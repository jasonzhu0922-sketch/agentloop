# HTML Effectiveness v2.0 整合总结

## 整合概述

本次整合将三个优秀项目的精华融合为一个更完善的 skill：

1. **html-effectiveness** (原版) — 11 种实用设计模式
2. **frontend-design by Anthropic** — 大胆的美学哲学
3. **open-design** — 工程严谨性和质量检查

## 文件更新清单

### 核心文件

| 文件 | 状态 | 更新内容 |
|------|------|---------|
| `SKILL.md` | ✅ 已更新 | 融合美学方向框架、五维自评、P0/P1/P2 检查清单、现代 CSS |
| `README.md` | ✅ 已更新 | 新增 v2.0 特性说明、安装指南、示例提示 |
| `BLOG.md` | ✅ 已更新 | 新增 v2.0 章节、五维自评、质量检查清单 |

### 参考文件

| 文件 | 状态 | 更新内容 |
|------|------|---------|
| `references/pattern-examples.md` | ✅ 已更新 | 新增 color-mix()、现代 CSS 技术、交互增强 |
| `references/complete-examples.md` | ✅ 已更新 | 新增设计系统示例、仪表盘、看板 |

### 展示文件

| 文件 | 状态 | 更新内容 |
|------|------|---------|
| `indexxxxxxx_en.html` | ✅ 已更新 | 全新设计，展示所有 11 种模式 |
| `indexxxxxxx_zh.html` | ✅ 已更新 | 中文版本，同步更新 |

## 主要改进

### 1. 美学方向框架 (Aesthetic Direction Framework)

新增 Step 0 预飞检查：
- Purpose（目的）
- Tone（调性）
- Constraints（约束）
- Differentiation（差异化）

### 2. 五维自评 (5-Dimension Self-Critique)

emit 前强制评分：
1. 哲学一致性 (Philosophy Consistency)
2. 视觉层级 (Visual Hierarchy)
3. 细节执行 (Detail Execution)
4. 功能性 (Functionality)
5. 创新性 (Innovation)

### 3. P0/P1/P2 质量检查清单

**P0 — 绝对不能发生**：
- 外部 CSS/JS 文件
- CDN 库
- `:root` 外的原始色值
- 紫色/紫罗兰渐变
- 表情符号作为图标
- 虚构指标
- 填充文本
- 忘记 `data-od-id`
- 移动端断流

**P1 — 应该避免**：
- 文字墙
- 纯黑/纯白
- 过度动画
- 通用 AI 美学
- Inter/Roboto 作为展示字体

### 4. 现代 CSS 技术

- **color-mix()**：派生色调
- **clamp()**：流体排版
- **text-wrap: pretty/balance**：美观断行
- **scroll-snap**：幻灯片体验
- **CSS 网格**：复杂布局

### 5. 演讲者模式 (Presenter Mode)

支持 `<aside class="notes">` 演讲者备注，按 S 键打开演讲者视图。

### 6. Live Artifact 支持

可刷新仪表盘的结构：template + data.json + artifact.json

## 设计系统升级

### 核心令牌 (6 个变量)

```css
:root {
  --bg:      #fafaf7;   /* 页面背景 */
  --surface: #ffffff;   /* 卡片、面板 */
  --fg:      #1a1916;   /* 主文本 */
  --muted:   #6b6964;   /* 次要文本 */
  --border:  #e8e5df;   /* 分隔线 */
  --accent:  #c96442;   /* 强调色 */
}
```

### 新增特性

- **color-mix() 派生**：`--accent-soft`、`--fg-soft`
- **8-point 网格**：`--gap-xs` 到 `--gap-2xl`
- **流体排版**：`clamp()` 用于 H1/H2
- **系统字体栈**：Display、Body、Mono 分离

## 模式目录增强

每种模式新增**美学增强**建议：

| 模式 | 新增增强 |
|------|---------|
| 并列对比 | 悬停提升动画、推荐项渐变边框 |
| 代码审查 | 语法高亮、行悬停效果 |
| 架构图 | 连接线动画、节点渐变填充 |
| 设计系统 | 交互式复制、色块过渡动画 |
| 幻灯片 | 交错内容揭示、渐变背景 |
| 交互式讲解 | 平滑展开/折叠、代码游乐场 |
| 状态报告 | 动画进度指示器、脉冲状态点 |
| 流程图 | 路径绘制动画、节点脉冲效果 |
| SVG 插图 | 悬停变换、协调配色 |
| 自定义编辑器 | 拖拽动画、切换微交互 |
| 仪表盘 | 数字计数动画、实时数据脉冲 |

## 反模式清单

### P0 — 绝对不能
- ❌ 外部 CSS/JS 文件
- ❌ CDN 库
- ❌ `:root` 外的原始色值
- ❌ 紫色/紫罗兰渐变背景
- ❌ 表情符号作为功能图标
- ❌ 虚构指标
- ❌ 填充文本
- ❌ 忘记 `data-od-id`
- ❌ 移动端断流

### P1 — 应该避免
- ❌ 文字墙
- ❌ 纯黑/纯白
- ❌ 过度动画
- ❌ 通用 AI 美学
- ❌ Inter/Roboto 作为展示字体
- ❌ KPI 卡片上的玻璃态
- ❌ KPI 数字下的彩色进度条
- ❌ 可见幻灯片上的演讲者文本

### P2 — 最好避免
- ❌ 加载重型动画框架
- ❌ 同一页面混合图片风格

## 输出规范

```
<artifact identifier="kebab-case-slug" type="text/html" title="Human Title">
<!doctype html>
<html>...</html>
</artifact>
```

## 版本信息

- **版本**: v2.0
- **更新日期**: 2026-05-20
- **作者**: Yardon (https://github.com/YardonYan)
- **许可证**: Apache 2.0

## 致谢

- **原版**: [The Unreasonable Effectiveness of HTML](https://github.com/ThariqS/html-effectiveness) by Thariq Shihipar
- **美学哲学**: [frontend-design](https://github.com/anthropics/skills/tree/main/skills/frontend-design) by Anthropic
- **工程严谨性**: [open-design](https://github.com/opendesign) by OpenDesign

---

# v2.1 更新 (May 2026) - open-design-main 深度整合

## 整合概述

v2.1 的核心变革是将 **open-design-main** 的成熟 Critique 系统和 **html-ppt** 的演示能力深度整合进 html-skill-effectiveness。这不是一次"加几个 feature"的增量更新，而是一次**工作哲学层面的升级**——从"生成一次"到"生成、批判、精炼、收敛"。

## 对比分析

| 维度 | html-skill-effectiveness v2.0 | open-design-main | 整合决策 |
|------|------|------|------|
| **Critique** | 简单五维自评 | 雷达图+乐队评分+证据驱动+Keep/Fix/Quick-wins | 采用open-design增强版 |
| **迭代机制** | 无 | DevLoop (critique.score≥4收敛) | 新增DevLoop |
| **模式数量** | 11 | 100+ 设计模板 | 精选2个(Critique+Frame Effects)补充 |
| **PPT能力** | 基础scroll-snap | 36主题+31布局+15全deck+27动画+20Canvas FX | 引用增强 |
| **Live Artifact** | 概念提及 | 成熟工作流(template+data+artifact+provenance) | 新模式#12 |
| **动画系统** | 基础CSS hover/transition | 27 CSS animations + 20 canvas FX | 新模式#13 |
| **设计系统** | 6核心令牌 | 多设计系统引用(HuggingFace/IBM) | 保持6令牌哲学 |
| **反模式** | P0-P2三级 | 评分纪律(不平均、不膨胀) | 合并两者 |

### 整合决策详解

1. **Critique 系统**：v2.0 的五维自评是一个好的起点，但太粗糙——"哲学一致性 7 分"意味着什么？v2.1 采用 open-design-main 的完整 Critique 框架：雷达图可视化、乐队评分（0-10）、每个分数附带证据引用、输出结构化为 Keep/Fix/Quick-wins 三个行动清单。

2. **DevLoop 迭代**：这是 v2.1 最大的哲学转变。open-design-main 的 DevLoop 概念证明了一个事实——AI 生成的第一版很少有完美的。通过 critique → fix → repeat 的循环，质量能从"还行"收敛到"优秀"。收敛条件设为 score ≥ 4（Acceptable 乐队），确保没有设计缺陷。

3. **模式扩展**：open-design-main 有 100+ 设计模板，但不是所有都适合单文件 HTML 场景。精选了 2 个最互补的：Live Artifact Dashboard（弥补数据看板的动态刷新能力）和 Frame Effects（弥补视觉冲击力的 CSS 动画系统）。

4. **PPT 增强**：v2.0 的幻灯片模式只有基础 scroll-snap。html-ppt 提供了完整的演示解决方案——36 个预置主题、31 种布局、Canvas 背景特效、演讲者模式。v2.1 将这些整合为幻灯片模式的增强选项。

5. **评分纪律**：open-design-main 最被低估的贡献是**评分纪律**——不平均（每个维度独立判断）、不膨胀（7+ 需要例外级证据）、证据引用（每个分数附带具体观察）。v2.1 将这些纪律写入了 Critique 系统的核心规则。

## v2.1 具体更新

### 1. Enhanced Critique System
- 从 5 维扩展到 6 维（新增可访问性维度）
- SVG 雷达图可视化输出
- 乐队评分：Critical(0-3) / Acceptable(4-6) / Strong(7-8) / Exceptional(9-10)
- 证据驱动：每个分数必须引用页面中的具体元素
- Keep / Fix / Quick-wins 三分法结构化输出

### 2. DevLoop Iterative Refinement
- 系统化迭代循环：critique → fix → repeat
- 收敛条件：所有维度 score ≥ 4
- 实际使用中 1-2 轮即可收敛
- 可配置目标分数（默认 4，可手动设为 7）

### 3. New Pattern #12: Live Artifact Dashboard
- 数据与表现分离（template + data.json）
- 来源追踪 (provenance tracking)
- 可刷新架构（修改 data.json 自动更新）
- 多 Dashboard 可组合

### 4. New Pattern #13: Frame Effects / Visual Moments
- 6 种纯 CSS 视觉特效：Glitch、Liquid、Light Leak、Blob、Scanlines、Spotlight
- "一次一个亮点"使用原则
- 关键时刻抓注意力，不经意的视觉惊喜

### 5. PPT Pattern Enhancement
- 36 个预置主题（从极简到赛博朋克）
- 31 种布局变体
- 15 个完整 Deck 模板
- 27 种 CSS 入场/过渡/强调动画
- 20 个 Canvas FX 背景特效
- 增强版演讲者模式（当前页+下一页预览+备注+计时器）

### 6. Scoring Discipline Rules
- **不平均**：六个维度各自独立评分
- **不膨胀**：7 分以上需要例外级证据
- **证据引用**：每个分数附带具体观察

### 7. Critique Report Output Contract
- 标准化输出格式
- 包含：雷达图 SVG、乐队摘要、证据表、Keep/Fix/Quick-wins 清单
- 可单独输出或附在 artifact 中

## 文件更新清单

| 文件 | 更新内容 |
|------|---------|
| `SKILL.md` | 增强critique + DevLoop + 2新模式 + PPT增强 + 评分纪律 |
| `README.md` | v2.1特性说明 + 模式表更新 + credits更新 |
| `BLOG.md` | v2.1博客章节：The Critique Revolution |
| `INTEGRATION_SUMMARY.md` | 本文件更新 |
| `references/critique-guide.md` | 新建 - 完整critique指南 |
| `references/frame-effects.md` | 新建 - Frame Effects模式参考 |
| `references/pattern-examples.md` | 更新 - 新增Live Artifact和Frame Effects代码 |
| `references/complete-examples.md` | 更新 - 新增完整示例 |
| `indexxxxxxx_en.html` | 更新 - 新增模式展示 |
| `indexxxxxxx_zh.html` | 更新 - 中文同步 |

## 版本信息

- **版本**: v2.1
- **更新日期**: 2026-05-21
- **作者**: Yardon (https://github.com/YardonYan)
- **许可证**: Apache 2.0

## v2.1 致谢

- **Critique 系统 & DevLoop**: [open-design-main](https://github.com/opendesign) by OpenDesign — 雷达图 critique、乐队评分、DevLoop 收敛
- **PPT/Slide 增强**: [html-ppt](https://github.com/opendesign) — 36 主题、31 布局、Canvas FX、Presenter Mode
- **持续增强**: 基于 open-design-main 的 critique 方法论和 html-ppt 的演示系统的最佳实践

---

# v3.0 更新 (May 2026) - Craft Discipline Revolution

## 整合概述

v3.0 的核心变革是将 **open-design-main** 的完整工艺纪律系统（7 个 craft rule 文件 + 2 个契约文件）深度整合进 html-skill-effectiveness。这不是一次"加几个 feature"的增量更新，而是一次**设计纪律层面的升级**——从"凭感觉检查"到"基于一手研究的可执行约束"。

## 对比分析

| 维度 | html-skill-effectiveness v2.1 | open-design craft rules | 整合决策 |
|------|------|------|------|
| **反AI味** | P0 简单列表（10条） | 七大罪 + 软信号 + 灵魂公式(80/20) | 增强P0至15条 + 灵魂公式 |
| **色彩** | 6核心令牌 + 调色板 | 四层调色板结构 + 强调色纪律 + 对比度门控 | 增加四层结构 + 强调色2次/屏上限 |
| **排版** | 字体/尺寸表 | 乘法刻度 + letter-spacing规则 + 三权重体系 | 增加 letter-spacing 强制规则 + 三权重 |
| **排版层级** | 无 | 五向量 + 三级模型 + 受控违规 + 编辑排版 | 新增完整层级章节 |
| **动画** | 基础CSS hover/transition | 精确时长阈值 + 曲线vs弹簧 + 减少动画 + 3个民间传说纠正 | 新增 animation-discipline 完整规则 |
| **可访问性** | 6行简单规则 | WCAG法律底线(4司法管辖区) + 对比度 + 触摸目标 + ARIA纪律 + 常见错误 | 全面增强，增加法律底线和ARIA纪律 |
| **UX法则** | 无 | 26条可执行法则（格式塔/注意/决策/记忆/交互/行为） | 新增 UX Laws 章节 |
| **状态覆盖** | 无 | 5必须状态 + 加载时长指示器 + 空状态/错误状态组成 | 新增 State Coverage 章节 |
| **表单验证** | 无 | 8状态输入状态机 + 4条验证时序规则 + `:user-invalid` | 新增 Form Validation 章节 |

### 整合决策详解

1. **Anti-AI-Slop（反AI味）**：v2.1 的 P0 列表是好的起点，但不够精确。v3.0 整合了 open-design 的七大罪——每条都解释了"为什么错"和"怎么修"。灵魂公式（80%成熟模式 + 20%独特选择）特别有价值，它给出了"如何不AI味"的可执行答案。P0 从 10 条增至 15 条。

2. **Color（色彩）**：四层调色板结构（中性70-90%、强调5-10%、语义0-5%、效果<1%）是 open-design 最实用的贡献之一。v2.1 有 6 个核心令牌但没有层级约束。v3.0 增加了四层结构，并强制"强调色每屏最多2处可见使用"——这是解决 AI 输出中最常见问题的硬规则。

3. **Typography（排版）**：letter-spacing 规则是 open-design 最被低估的贡献——"ALL CAPS 必须 ≥0.06em"、"display 必须 -0.02em 到 -0.03em"——这两条是区分"业余"和"专业"的最可靠标志。三权重体系（Read/Emphasize/Announce）简化了权重选择。

4. **Typography Hierarchy（排版层级）**：五向量模型（Scale/Weight/Spacing/Tracking/Alignment）是 v3.0 最重要的概念性贡献。它解释了为什么"只靠字号大小"的层级是脆弱的——任何布局约束都能破坏它。三级工作模型（Primary/Secondary/Tertiary）为设计决策提供了清晰框架。

5. **Animation Discipline（动画纪律）**：150ms 默认时长、曲线vs弹簧的选择、`prefers-reduced-motion` 的精确规则——这些都是基于一手研究的（Tversky 2002, Material 3, IBM Carbon）。三个民间传说纠正（skeleton 11%更快、Doherty 400ms、M2 曲线标为 M3）特别有价值。

6. **Accessibility Baseline（可访问性底线）**：WCAG 法律底线因司法管辖区而异——这个事实被绝大多数 AI 设计指南忽略。v3.0 给出了 4 个司法管辖区的精确标准。ARIA 纪律（WebAIM 2026: ARIA 页面平均 59.1 错误 vs 非 ARIA 42 错误）是反直觉但关键的数据。

7. **Laws of UX（UX法则）**：26 条可执行法则，每条都有明确的执行指令。精选了最实用的：格式塔法则（感知）、注意法则、决策法则（Hick/选择过载/帕累托）、记忆法则（Cowan 4±1/Peak-End）、交互法则（Fitts/Doherty/Postel）、行为法则（Jakob/认知负荷/目标梯度）。

8. **State Coverage（状态覆盖）**：5 必须状态（Loading/Empty/Error/Populated/Edge）是 AI 生成 UI 中最常见的缺失——AI 只画"数据存在"的状态。v3.0 增加了加载时长→指示器对照表和错误状态三问（发生了什么/为什么/怎么办）。

9. **Form Validation（表单验证）**：8 状态输入状态机和 4 条验证时序规则解决了 AI 生成表单中最常见的错误——过早验证、`:invalid` 不分时机地显示红框、错误信息过于笼统。

## v3.0 具体更新

### 1. Craft Rules 章节（新增约 19KB）
- 7 个子章节 + State Coverage + Form Validation
- 所有规则基于一手研究，引用具体来源

### 2. P0 Anti-Patterns 增强（10→15 条）
新增：
- ALL CAPS 无 letter-spacing
- display 文字无负 tracking
- serif 约束下用 sans-serif 做展示
- 圆角卡片+彩色左边框
- `:invalid` 不用 `:user-invalid`

### 3. P1 Anti-Patterns 增强（新增 6 条）
新增：
- 标准 Hero→Features 模板无变化
- 外部占位图 CDN
- 强调色超过 2 次/屏
- 装饰性动画
- `outline: none` 无替代
- 首次击键就验证

### 4. Design System 微调
- 在 Craft Rules 中增加四层调色板结构
- 在 Craft Rules 中增加 letter-spacing 规则
- 在 Craft Rules 中增加三权重体系

### 5. 新增文件
- `RELEASE-v3.0.md` — 发布说明
- `references/craft-rules-reference.md` — 工艺规则快速参考

### 6. 已更新文件
- `SKILL.md` — 核心技能定义（42KB → 63KB）
- `README.md` — 项目说明
- `BLOG.md` — 博客文章
- `INTEGRATION_SUMMARY.md` — 本文件

## 版本信息

- **版本**: v3.0
- **更新日期**: 2026-05-21
- **作者**: Yardon (https://github.com/YardonYan)
- **许可证**: Apache 2.0

## v3.0 致谢

- **Craft Rules 系统**: [open-design-main](https://github.com/opendesign) by OpenDesign — anti-ai-slop, color, typography, typography-hierarchy, animation-discipline, accessibility-baseline, laws-of-ux, state-coverage, form-validation
- **研究来源**: Tversky/Morrison/Bétrancourt 2002, Bringhurst *Elements of Typographic Style*, WCAG 2.2, WebAIM Million 2026, Baymard 2024, Material 3 motion tokens, ARIA APG, IBM Carbon Motion, Apple SwiftUI Animation API
- **前序版本**: v2.1 Critique Revolution, v2.0 设计系统整合, v1.0 html-effectiveness 原版
