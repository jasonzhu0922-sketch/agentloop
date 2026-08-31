# Pattern Examples

Real code snippets extracted from the reference collection, organized by pattern.

**Skill**: html-effectiveness by [Yardon](https://github.com/YardonYan) | May 2026
**Based on**: [The Unreasonable Effectiveness of HTML](https://github.com/ThariqS/html-effectiveness)

## 1. Side-by-Side Comparison

From `01-exploration-code-approaches.html` — Three approaches in a grid:

```css
.approaches {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 28px;
}
@media (max-width: 1100px) {
  .approaches { grid-template-columns: 1fr; }
}

.approach {
  background: var(--white);
  border: 1.5px solid var(--gray-300);
  border-radius: 14px;
  padding: 24px;
  display: flex;
  flex-direction: column;
}
.approach.recommended {
  border-color: var(--slate);
  box-shadow: 0 8px 24px rgba(20,20,19,.08);
}
```

Trade-off tags:
```css
.tag {
  font-family: var(--mono);
  font-size: 11px;
  padding: 3px 10px;
  border-radius: 999px;
  background: var(--gray-100);
  color: var(--gray-700);
}
.tag.pro { background: #E8F0E0; color: var(--olive); }
.tag.con { background: #F5E8E4; color: var(--rust); }
```

## 2. Annotated Diff

From `03-code-review-pr.html` — Diff block with margin notes:

```css
.diff-block {
  background: var(--white);
  border: 1.5px solid var(--gray-300);
  border-radius: 12px;
  overflow: hidden;
}
.diff-line {
  display: flex;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.6;
  padding: 2px 16px;
}
.diff-line.add {
  background: #F0F7EC;
  border-left: 3px solid var(--olive);
}
.diff-line.del {
  background: #FDF2F0;
  border-left: 3px solid var(--rust);
}
.diff-line .ln {
  color: var(--gray-500);
  width: 40px;
  flex-shrink: 0;
  text-align: right;
  padding-right: 12px;
}
```

Severity pills:
```css
.severity {
  font-family: var(--mono);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 2px 8px;
  border-radius: 999px;
}
.severity.critical { background: var(--rust); color: #fff; }
.severity.warn     { background: var(--clay); color: #fff; }
.severity.note     { background: var(--olive); color: #fff; }
.severity.style    { background: var(--gray-100); color: var(--gray-700); }
```

## 3. Module Map

From `04-code-understanding.html` — SVG architecture diagram:

```html
<svg viewBox="0 0 800 400" class="arch">
  <!-- Module box -->
  <rect x="50" y="50" width="140" height="60" rx="8"
        fill="var(--white)" stroke="var(--gray-300)" stroke-width="1.5"/>
  <text x="120" y="85" text-anchor="middle"
        font-family="var(--mono)" font-size="13" fill="var(--slate)">Router</text>

  <!-- Arrow -->
  <line x1="190" y1="80" x2="280" y2="80"
        stroke="var(--gray-300)" stroke-width="1.5"/>
  <polygon points="280,80 272,76 272,84" fill="var(--gray-300)"/>

  <!-- External (dashed) -->
  <rect x="300" y="50" width="140" height="60" rx="8" fill="none"
        stroke="var(--clay)" stroke-width="1.5" stroke-dasharray="4 4"/>
</svg>
```

## 4. Design System

From `05-design-system.html` — Color swatch grid:

```css
.swatch-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 16px;
}
.swatch {
  border-radius: var(--radius-row);
  overflow: hidden;
  border: var(--border);
}
.swatch .color {
  height: 80px;
}
.swatch .label {
  padding: 10px 12px;
  background: var(--white);
  font-family: var(--mono);
  font-size: 12px;
}
```

Typography scale:
```css
.type-scale .row {
  display: flex;
  align-items: baseline;
  gap: 20px;
  padding: 12px 0;
  border-bottom: 1px solid var(--gray-200);
}
.type-scale .size {
  font-family: var(--mono);
  font-size: 12px;
  color: var(--gray-500);
  width: 60px;
}
```

## 5. Slide Deck

From `09-slide-deck.html` — Scroll-snap slides:

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
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 8vh 6vw;
}
.slide.invert {
  background: var(--slate);
  color: var(--ivory);
}
```

Navigation:
```javascript
document.addEventListener('keydown', (e) => {
  const slides = document.querySelectorAll('.slide');
  const current = Math.round(window.scrollY / window.innerHeight);
  if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
    slides[Math.min(current + 1, slides.length - 1)]?.scrollIntoView();
  }
  if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
    slides[Math.max(current - 1, 0)]?.scrollIntoView();
  }
});
```

## 6. Interactive Explainer

From `15-research-concept-explainer.html` — Collapsible sections:

```html
<details class="deep-dive">
  <summary>How does virtual node placement work?</summary>
  <div class="content">
    <p>Each node is hashed to a point on the ring...</p>
  </div>
</details>
```

```css
details.deep-dive {
  border: 1.5px solid var(--gray-300);
  border-radius: 12px;
  padding: 16px 20px;
  margin-bottom: 12px;
}
details.deep-dive summary {
  font-weight: 500;
  cursor: pointer;
  list-style: none;
}
details.deep-dive summary::before {
  content: "▸";
  margin-right: 8px;
  color: var(--clay);
  display: inline-block;
  transition: transform 150ms;
}
details[open] summary::before {
  transform: rotate(90deg);
}
```

Interactive demo with slider:
```html
<div class="demo">
  <input type="range" min="1" max="10" value="3" id="nodeCount">
  <div id="ring"></div>
</div>
<script>
  const slider = document.getElementById('nodeCount');
  const ring = document.getElementById('ring');
  slider.addEventListener('input', (e) => {
    renderRing(parseInt(e.target.value));
  });
</script>
```

## 7. Status Report

From `11-status-report.html` — Health pills and mini chart:

```css
.health {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 4px 10px;
  border-radius: 999px;
}
.health::before {
  content: "";
  width: 6px; height: 6px;
  border-radius: 50%;
}
.health.on-track  { background: #E8F0E0; color: var(--olive); }
.health.on-track::before  { background: var(--olive); }
.health.at-risk   { background: #F5E8E4; color: var(--clay-d); }
.health.at-risk::before   { background: var(--clay); }
.health.blocked   { background: #F5E8E4; color: var(--rust); }
.health.blocked::before   { background: var(--rust); }
```

Mini bar chart (CSS-only):
```css
.bar-chart {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  height: 120px;
}
.bar {
  flex: 1;
  border-radius: 4px 4px 0 0;
  min-height: 4px;
}
.bar.done { background: var(--olive); }
.bar.in-progress { background: var(--clay); }
.bar.planned { background: var(--gray-200); }
```

## 8. Flowchart

From `13-flowchart-diagram.html` — Clickable SVG nodes:

```html
<svg viewBox="0 0 600 400">
  <g class="node" data-step="build" cursor="pointer">
    <rect x="100" y="100" width="120" height="50" rx="6"
          fill="var(--white)" stroke="var(--gray-300)" stroke-width="1.5"/>
    <text x="160" y="130" text-anchor="middle" font-size="13">Build</text>
  </g>
</svg>

<div class="detail-panel" id="details">
  <p>Click a step to see details</p>
</div>
```

```javascript
document.querySelectorAll('.node').forEach(node => {
  node.addEventListener('click', () => {
    const step = node.dataset.step;
    document.getElementById('details').innerHTML = detailData[step];
  });
});
```

## 9. SVG Illustration

From `10-svg-illustrations.html` — Reusable SVG classes:

```css
svg.figure .st { stroke: var(--g500); fill: none; stroke-width: 2.5; }
svg.figure .fl { fill: var(--g300); }
svg.figure .cl { fill: var(--clay); }
svg.figure .ol { fill: var(--olive); }
svg.figure .oa { fill: var(--oat); stroke: var(--g500); stroke-width: 2.5; }
svg.figure .sl { fill: var(--slate); }
svg.figure .wh { fill: var(--paper); stroke: var(--g500); stroke-width: 2.5; }
svg.figure .ln { stroke: var(--g500); stroke-width: 2.5; fill: none; stroke-linecap: round; }
```

## 10. Custom Editor

From `18-editor-triage-board.html` — Drag and drop:

```javascript
// HTML5 Drag API
card.draggable = true;
card.addEventListener('dragstart', (e) => {
  e.dataTransfer.setData('text/plain', card.dataset.id);
  card.classList.add('dragging');
});

column.addEventListener('dragover', (e) => {
  e.preventDefault();
  column.classList.add('drop-target');
});

column.addEventListener('drop', (e) => {
  e.preventDefault();
  const id = e.dataTransfer.getData('text/plain');
  const card = document.querySelector(`[data-id="${id}"]`);
  column.appendChild(card);
  updateState();
});
```

Export to markdown:
```javascript
function exportMarkdown() {
  const columns = document.querySelectorAll('.column');
  let md = '';
  columns.forEach(col => {
    md += `## ${col.dataset.name}\n\n`;
    col.querySelectorAll('.card').forEach(card => {
      md += `- ${card.querySelector('.title').textContent}\n`;
    });
    md += '\n';
  });
  navigator.clipboard.writeText(md);
}
```

## 11. Dashboard

Metric card with sparkline:

```css
.metric {
  background: var(--white);
  border: var(--border);
  border-radius: var(--radius-panel);
  padding: 24px;
}
.metric .value {
  font-family: var(--serif);
  font-size: 42px;
  font-weight: 500;
  color: var(--slate);
  letter-spacing: -0.02em;
}
.metric .delta {
  font-family: var(--mono);
  font-size: 13px;
}
.metric .delta.up   { color: var(--olive); }
.metric .delta.down { color: var(--rust); }

.sparkline {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 40px;
  margin-top: 16px;
}
.sparkline .bar {
  flex: 1;
  background: var(--gray-200);
  border-radius: 2px 2px 0 0;
}
.sparkline .bar:last-child {
  background: var(--clay);
}

## 12. Live Artifact / Refreshable Dashboard

From `22-refreshable-dashboard.html` — Real-time data injection with template binding:

```html
<!-- Template binding pattern -->
<div id="dashboard">
  <div class="metric-card">
    <span class="label">{{data.revenue.label}}</span>
    <span class="value">{{data.revenue.value}}</span>
    <span class="delta {{data.revenue.trend}}">{{data.revenue.delta}}</span>
  </div>
</div>
```

```javascript
// Data injection for standalone HTML
const data = {
  revenue: { label: "Monthly Revenue", value: "$128,430", delta: "+12.4%", trend: "up" },
  users: { label: "Active Users", value: "8,249", delta: "+3.2%", trend: "up" },
  churn: { label: "Churn Rate", value: "2.1%", delta: "-0.3%", trend: "down" }
};
// Template engine
document.querySelectorAll('[data-bind]').forEach(el => {
  const path = el.dataset.bind.split('.');
  let val = data;
  path.forEach(k => val = val[k]);
  if (el.classList.contains('delta')) {
    el.className = `delta ${data[path[0]].trend}`;
  }
  el.textContent = val;
});
```

```css
/* Refreshable dashboard layout */
.dashboard-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--gap);
  margin-bottom: var(--gap-xl);
}
@media (max-width: 920px) {
  .dashboard-grid { grid-template-columns: repeat(2, 1fr); }
}
.metric-card {
  background: var(--surface);
  border: var(--border);
  border-radius: var(--radius-panel);
  padding: 24px;
  transition: box-shadow 200ms ease;
}
.metric-card:hover { box-shadow: 0 4px 20px rgba(0,0,0,.06); }
.metric-card .label {
  font-family: var(--mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  display: block;
  margin-bottom: 8px;
}
.metric-card .value {
  font-family: var(--serif);
  font-size: clamp(28px, 3.5vw, 42px);
  font-weight: 500;
  color: var(--fg);
  letter-spacing: -0.02em;
  display: block;
  margin-bottom: 4px;
}
.metric-card .delta {
  font-family: var(--mono);
  font-size: 13px;
}
.metric-card .delta.up { color: var(--olive); }
.metric-card .delta.down { color: var(--rust); }

/* Refresh indicator */
.refresh-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--muted);
  padding: 6px 12px;
  border: var(--border);
  border-radius: 999px;
  cursor: pointer;
  transition: all 150ms ease;
}
.refresh-badge:hover { border-color: var(--accent); color: var(--accent); }
.refresh-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--olive); }
.refresh-badge .dot.stale { background: var(--clay); animation: pulse 2s infinite; }
@keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }
```

## 13. Frame Effects / Visual Moments

From `23-frame-effects.html` — CSS-only animation techniques for cinematic presentation:

```css
/* Glitch Title Effect */
@keyframes glitch-1 {
  0%, 100% { clip-path: inset(0 0 0 0); transform: translate(0); }
  20% { clip-path: inset(20% 0 60% 0); transform: translate(-3px, 2px); }
  40% { clip-path: inset(40% 0 40% 0); transform: translate(3px, -1px); }
  60% { clip-path: inset(60% 0 20% 0); transform: translate(-2px, 1px); }
  80% { clip-path: inset(10% 0 70% 0); transform: translate(2px, -2px); }
}
@keyframes glitch-2 {
  0%, 100% { clip-path: inset(0 0 0 0); transform: translate(0); }
  25% { clip-path: inset(35% 0 45% 0); transform: translate(2px, -2px); }
  55% { clip-path: inset(55% 0 25% 0); transform: translate(-2px, 1px); }
  85% { clip-path: inset(15% 0 65% 0); transform: translate(3px, -1px); }
}
.glitch-title {
  position: relative;
  font-family: var(--serif);
  font-size: clamp(48px, 8vw, 96px);
  font-weight: 700;
}
.glitch-title::before,
.glitch-title::after {
  content: attr(data-text);
  position: absolute;
  top: 0; left: 0;
  width: 100%; height: 100%;
}
.glitch-title::before {
  color: #ff6b6b;
  z-index: -1;
  animation: glitch-1 3s infinite linear alternate-reverse;
}
.glitch-title::after {
  color: #4ecdc4;
  z-index: -2;
  animation: glitch-2 2.5s infinite linear alternate-reverse;
}

/* Liquid Background Hero */
@keyframes liquid-morph {
  0%, 100% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
  25% { border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%; }
  50% { border-radius: 50% 50% 50% 70% / 50% 40% 70% 60%; }
  75% { border-radius: 40% 60% 30% 50% / 70% 40% 60% 50%; }
}
.liquid-bg {
  position: relative;
  overflow: hidden;
}
.liquid-bg::before {
  content: '';
  position: absolute;
  width: 140%;
  height: 140%;
  top: -20%;
  left: -20%;
  background: linear-gradient(135deg, var(--accent), var(--olive), var(--oat));
  opacity: 0.15;
  animation: liquid-morph 8s ease-in-out infinite;
  z-index: 0;
}

/* Light Leak Cinema Effect */
@keyframes light-leak {
  0%, 90%, 100% { opacity: 0; }
  95% { opacity: 0.08; }
}
.cinema-frame {
  position: relative;
}
.cinema-frame::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    transparent 40%,
    rgba(255, 200, 100, 0.15) 50%,
    transparent 60%
  );
  pointer-events: none;
  animation: light-leak 6s ease-in-out infinite;
}

/* Entry Animation Utilities */
.anim-fade-up {
  opacity: 0;
  transform: translateY(24px);
  animation: fade-up 0.6s cubic-bezier(0.23, 1, 0.32, 1) forwards;
}
@keyframes fade-up {
  to { opacity: 1; transform: translateY(0); }
}
.anim-stagger > * {
  opacity: 0;
  animation: fade-up 0.5s cubic-bezier(0.23, 1, 0.32, 1) forwards;
}
.anim-stagger > *:nth-child(1) { animation-delay: 0s; }
.anim-stagger > *:nth-child(2) { animation-delay: 0.1s; }
.anim-stagger > *:nth-child(3) { animation-delay: 0.2s; }
.anim-stagger > *:nth-child(4) { animation-delay: 0.3s; }
.anim-stagger > *:nth-child(5) { animation-delay: 0.4s; }

/* Logo Outro */
@keyframes logo-reveal {
  0% { clip-path: inset(0 100% 0 0); opacity: 0; }
  50% { clip-path: inset(0 0 0 0); opacity: 1; }
  100% { clip-path: inset(0 0 0 0); opacity: 1; }
}
.logo-outro {
  animation: logo-reveal 1.2s cubic-bezier(0.23, 1, 0.32, 1) forwards;
}
```
```
