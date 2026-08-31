---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_d1fa18c473c711f1986d525400d9a7a1
    ReservedCode1: 2RlsaylxlVoMHmJHutunBQUUtymOJL17raJzgFBvQnKaORdPfLcAyt15rA/1QeTYh5wMho3084YTYpzdIoCjTREE62hadaSTUhPWl3QMqxfpATWIoNGUgV4kAgcvPR6hEaY+Ta4rAGYGILSsNKpTdxiu1+rkW2+Evb+/E7BjpRLGOlOLtardyD+I3ms=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_d1fa18c473c711f1986d525400d9a7a1
    ReservedCode2: 2RlsaylxlVoMHmJHutunBQUUtymOJL17raJzgFBvQnKaORdPfLcAyt15rA/1QeTYh5wMho3084YTYpzdIoCjTREE62hadaSTUhPWl3QMqxfpATWIoNGUgV4kAgcvPR6hEaY+Ta4rAGYGILSsNKpTdxiu1+rkW2+Evb+/E7BjpRLGOlOLtardyD+I3ms=
---

# UX Laws Reference · UX 法则完整参考

26 条 UX 法则完整版，每条包含：法则名称 / 英文原名 / 来源 / 一句话定义 / 可执行指令 / 在 HTML Skill 中的应用。

从 SKILL.md Craft Rule 7 中提取并扩展。

---

## Gestalt Laws / 格式塔法则

### 1. Law of Proximity · 邻近法则
- **来源**: Wertheimer 1923, *Untersuchungen zur Lehre von der Gestalt*
- **定义**: 空间上接近的物体被感知为同一组。
- **可执行指令**: Related items ≤8px spacing; unrelated items ≥24px spacing.
- **在 HTML Skill 中**: 用 `gap` 属性分组卡片、列表项；相关表单字段紧密排列。

### 2. Law of Similarity · 相似法则
- **来源**: Wertheimer 1923
- **定义**: 外观相似的物体被感知为同一类。
- **可执行指令**: Use same visual treatment (color, shape, size) for items of same type/category.
- **在 HTML Skill 中**: 相同类型的按钮、标签、卡片使用一致的 class 和 token。

### 3. Law of Continuity · 连续法则
- **来源**: Wertheimer 1923
- **定义**: 眼睛倾向于沿着连续路径或曲线移动。
- **可执行指令**: Align items along continuous line/curve; don't break visual flow with misaligned elements.
- **在 HTML Skill 中**: Timeline 模式使用连续的垂直线 + 对齐的事件卡片。

### 4. Law of Closure · 闭合法则
- **来源**: Wertheimer 1923
- **定义**: 大脑会自动补全不完整的图形。
- **可执行指令**: Use partial outlines; let eye complete the shape. Prefer incomplete over heavy borders.
- **在 HTML Skill 中**: 卡片使用半透明边框代替实线边框；进度条使用不完整环。

### 5. Law of Prägnanz · 简洁法则
- **来源**: Wertheimer 1923 / Koffka 1935
- **定义**: 人们倾向于用最简单的方式感知模糊图形。
- **可执行指令**: Simplicity first. If a simpler arrangement conveys same info, use it.
- **在 HTML Skill 中**: 删除冗余装饰；一个 section 只做一件事。

---

## Attention Laws / 注意力法则

### 6. Figure-Ground · 图底关系
- **来源**: Rubin 1915, *Synsoplevede Figurer*
- **定义**: 人们本能地区分前景（图形）和背景。
- **可执行指令**: Ensure active element has clear contrast against background. Test: grayscale — does figure still pop?
- **在 HTML Skill 中**: Modal/Toast 使用 `--surface` 背景 + `box-shadow` 提升层级感。

### 7. Focal Point · 焦点法则
- **来源**: Buswell 1935, *How People Look at Pictures*
- **定义**: 画面中最突出的元素自动成为视觉入口。
- **可执行指令**: One dominant element per screen. If two compete, demote one.
- **在 HTML Skill 中**: Hero section 只放一个主要标题 + 一个 CTA；不放置多个竞争性视觉元素。

### 8. Common Region · 共同区域
- **来源**: Palmer 1992, *Common Region: A New Principle of Perceptual Grouping*
- **定义**: 同一边界内的元素被感知为相关的。
- **可执行指令**: Items inside same bounded region read as related. Use to group without adding lines.
- **在 HTML Skill 中**: 使用 `background: var(--surface)` + `border` 包裹相关控件，避免额外分隔线。

---

## Decision Laws / 决策法则

### 9. Hick's Law · 希克法则
- **来源**: Hick 1952, *On the Rate of Gain of Information*; Hyman 1953
- **定义**: 选择数量越多，决策时间越长（对数关系）。
- **可执行指令**: For >7 options, add search/filter OR group into 3-5 categories.
- **在 HTML Skill 中**: 导航菜单不超过 7 项；表格添加筛选/搜索。

### 10. Choice Overload · 选择过载
- **来源**: Iyengar & Lepper 2000, *When Choice is Demotivating*
- **定义**: 选项过多导致决策瘫痪和满意度下降。
- **可执行指令**: Primary actions cap at 3 choices max.
- **在 HTML Skill 中**: CTA 栏最多 3 个按钮（Primary / Secondary / Text）。

### 11. Pareto Principle · 帕累托原则 (80/20)
- **来源**: Pareto 1896 / Juran 1951
- **定义**: 80% 的效果来自 20% 的原因。
- **可执行指令**: 80% users use 20% features. Make the 20% prominent; bury the 80%.
- **在 HTML Skill 中**: Dashboard 顶层只展示核心 KPI；详情放到可展开区域。

### 12. Tesler's Law · 泰斯勒定律
- **来源**: Tesler 1984, interview in *Designing for People*
- **定义**: 复杂性无法消除，只能转移。
- **可执行指令**: Move complexity to where user has most context to handle it.
- **在 HTML Skill 中**: 高级配置放到折叠面板；默认显示简化视图。

### 13. Occam's Razor · 奥卡姆剃刀
- **来源**: William of Ockham, 14th century
- **定义**: 如无必要，勿增实体。
- **可执行指令**: If two components/paths achieve same goal, simpler one wins. Delete the other.
- **在 HTML Skill 中**: 页面中每个 section 必须通过"是否可以删除"测试。

---

## Memory Laws / 记忆法则

### 14. Miller's Law / Chunking · 米勒定律 / 组块
- **来源**: Miller 1956; **修正**: Cowan 2001, *The Magical Number 4 in Short-Term Memory*
- **定义**: 工作记忆容量为 4±1 个组块（非 Miller 的 7±2）。
- **可执行指令**: Group items into 3-5 item chunks.
- **在 HTML Skill 中**: 卡片网格每行 3-4 个；列表按 5 项内分组。

### 15. Peak-End Rule · 峰终定律
- **来源**: Kahneman et al. 1993, *When More Pain is Preferred to Less*
- **定义**: 人们对体验的记忆主要取决于峰值和结尾。
- **可执行指令**: Make the peak and the exit deliberate.
- **在 HTML Skill 中**: 页面中部设计一个记忆点（惊艳的图表/引用）；结尾放强 CTA。

### 16. Zeigarnik Effect · 蔡格尼克效应
- **来源**: Zeigarnik 1927, *Über das Behalten von erledigten und unerledigten Handlungen*
- **定义**: 未完成的任务比已完成的任务更容易被记住。
- **可执行指令**: Show progress indicators for multi-step flows.
- **在 HTML Skill 中**: 多步表单显示步骤进度条；Dashboard 显示"进行中"项目数。

---

## Interaction Laws / 交互法则

### 17. Fitts's Law · 费茨法则
- **来源**: Fitts 1954, *The Information Capacity of the Human Motor System*
- **定义**: 目标获取时间 = f(距离, 大小）。更大、更近的目标更容易点击。
- **可执行指令**: Primary actions large (≥44px) and placed close to likely cursor position.
- **在 HTML Skill 中**: CTA 按钮至少 44px 高；移动端全宽按钮。

### 18. Doherty Threshold · 多尔蒂阈值
- **来源**: Doherty & Thadani 1982, *The Economic Value of Rapid Response Time*
- **定义**: 系统响应 ≤400ms 让用户保持心流。
- **可执行指令**: Optimize first paint, then interaction response. ≤200ms feels magical.
- **在 HTML Skill 中**: 骨架屏在 300ms+ 时显示；≤300ms 直接渲染。

### 19. Postel's Law (Robustness) · 波斯戴尔定律
- **来源**: Postel 1981, RFC 793 (TCP)
- **定义**: 对发送保守，对接收宽容。
- **可执行指令**: Accept flexible input (dates, phones); output strict standards.
- **在 HTML Skill 中**: 表单接受多种日期格式输入；输出标准化 ISO 格式。

---

## Behavioral Laws / 行为法则

### 20. Jakob's Law · 雅各布定律
- **来源**: Nielsen 2000, *End of Web Design*
- **定义**: 用户大部分时间花在其他网站上，期望你的网站运作方式类似。
- **可执行指令**: Match familiar patterns for navigation, CRUD, auth. Only innovate after nailing baseline.
- **在 HTML Skill 中**: 导航放在顶部；搜索框在右侧；logo 点击返回首页。

### 21. Cognitive Load · 认知负荷
- **来源**: Sweller 1988, *Cognitive Load During Problem Solving*
- **定义**: 工作记忆处理能力有限，超出则学习/决策受损。
- **可执行指令**: Split complex tasks into steps. Use progressive disclosure.
- **在 HTML Skill 中**: 使用折叠面板隐藏高级选项；多步向导代替单页表单。

### 22. Goal Gradient · 目标梯度
- **来源**: Hull 1932, *The Goal-Gradient Hypothesis*
- **定义**: 离目标越近，努力意愿越强。
- **可执行指令**: Perceived progress accelerates effort. Show progress bar; celebrate milestones.
- **在 HTML Skill 中**: 进度条分段显示；完成步骤后给予正面反馈。

---

## Additional Laws / 补充法则

### 23. Aesthetic-Usability Effect · 美即好用效应
- **来源**: Kurosu & Kashimura 1995; Tractinsky 2000
- **定义**: 用户认为美观的设计更易用。
- **可执行指令**: Visual polish reduces perceived difficulty. Beauty is functional.
- **在 HTML Skill 中**: 所有工件必须通过 P0 视觉质量检查。

### 24. Von Restorff Effect · 冯·雷斯托夫效应
- **来源**: Von Restorff 1933
- **定义**: 与众不同的项目更容易被记住。
- **可执行指令**: Make the important element visually distinct from its neighbors.
- **在 HTML Skill 中**: 推荐选项用不同的边框颜色或阴影突出。

### 25. Serial Position Effect · 序列位置效应
- **来源**: Ebbinghaus 1885; Murdock 1962
- **定义**: 列表中的首项和末项更容易被记住（首因效应 + 近因效应）。
- **可执行指令**: Place most important items first and last in lists.
- **在 HTML Skill 中**: 导航首尾放核心入口；定价表首尾放推荐方案。

### 26. Progressive Disclosure · 渐进式披露
- **来源**: Nielsen 2006, *Progressive Disclosure*
- **定义**: 初始只展示核心信息，按需展开详情。
- **可执行指令**: Hide complexity until requested. Default = simple, opt-in = advanced.
- **在 HTML Skill 中**: 使用 `<details>` 元素或折叠面板收纳详细信息。
*（内容由AI生成，仅供参考）*
