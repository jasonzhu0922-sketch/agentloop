# Complete Examples

Full HTML files demonstrating each pattern in context.

**Skill**: html-effectiveness by [Yardon](https://github.com/YardonYan) | May 2026
**Based on**: [The Unreasonable Effectiveness of HTML](https://github.com/ThariqS/html-effectiveness)

## Example 1: Side-by-Side Comparison

**File**: `01-exploration-code-approaches.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Approaches Comparison</title>
<style>
  :root {
    --bg: #FAF9F5; --surface: #FFFFFF; --fg: #141413; --muted: #87867F;
    --border: #D1CFC5; --accent: #D97757;
    --font-display: 'Iowan Old Style', 'Charter', Georgia, serif;
    --font-body: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    --font-mono: ui-monospace, 'JetBrains Mono', Menlo, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: var(--font-body); background: var(--bg); color: var(--fg); line-height: 1.55; padding: 56px 24px 96px; }
  .page { max-width: 980px; margin: 0 auto; }
  h1 { font-family: var(--font-display); font-size: clamp(38px, 5.4vw, 62px); font-weight: 500; letter-spacing: -0.02em; margin: 0 0 16px; }
  .subtitle { color: var(--muted); font-size: 18px; margin-bottom: 48px; }
  .approaches { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 28px; }
  @media (max-width: 1100px) { .approaches { grid-template-columns: 1fr; } }
  .approach { background: var(--surface); border: 1.5px solid var(--border); border-radius: 14px; padding: 24px; display: flex; flex-direction: column; transition: transform 150ms ease, box-shadow 150ms ease; }
  .approach:hover { transform: translateY(-3px); box-shadow: 0 10px 30px rgba(20,20,19,.10); }
  .approach.recommended { border-color: var(--fg); box-shadow: 0 8px 24px rgba(20,20,19,.08); }
  .badge { font-family: var(--font-mono); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; padding: 4px 10px; border-radius: 999px; background: var(--bg); display: inline-block; margin-bottom: 12px; }
  .badge.recommended { background: var(--fg); color: var(--bg); }
  h3 { font-family: var(--font-display); font-size: 22px; font-weight: 600; margin: 0 0 12px; }
  .pros, .cons { list-style: none; padding: 0; margin: 0 0 16px; }
  .pros li::before { content: "✓"; color: var(--olive); margin-right: 8px; }
  .cons li::before { content: "✗"; color: var(--rust); margin-right: 8px; }
  .tag { font-family: var(--font-mono); font-size: 11px; padding: 3px 10px; border-radius: 999px; background: var(--bg); }
  .tag.pro { background: #E8F0E0; color: #4A7C3F; }
  .tag.con { background: #F5E8E4; color: #B04A3F; }
</style>
</head>
<body>
<div class="page">
  <h1>Code Approaches</h1>
  <p class="subtitle">Three ways to structure the same feature</p>
  <div class="approaches">
    <div class="approach">
      <span class="badge">Approach A</span>
      <h3>Client-side Render</h3>
      <ul class="pros"><li>Fast navigation</li><li>Rich interactions</li></ul>
      <ul class="cons"><li>Slow first paint</li><li>Poor SEO</li></ul>
      <span class="tag pro">Good for apps</span>
    </div>
    <div class="approach recommended">
      <span class="badge recommended">Recommended</span>
      <h3>Static Generation</h3>
      <ul class="pros"><li>Fast load</li><li>Great SEO</li><li>Low cost</li></ul>
      <ul class="cons"><li>Build time</li></ul>
      <span class="tag pro">Good for content</span>
    </div>
    <div class="approach">
      <span class="badge">Approach C</span>
      <h3>Server Components</h3>
      <ul class="pros"><li>Best of both</li><li>Streaming</li></ul>
      <ul class="cons"><li>Complex setup</li><li>Framework lock</li></ul>
      <span class="tag con">Complex</span>
    </div>
  </div>
</div>
</body>
</html>
```

## Example 2: Annotated Diff

**File**: `03-code-review-pr.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Code Review</title>
<style>
  :root {
    --bg: #FAF9F5; --surface: #FFFFFF; --fg: #141413; --muted: #87867F;
    --border: #D1CFC5; --accent: #D97757; --olive: #788C5D; --rust: #B04A3F;
    --font-mono: ui-monospace, 'JetBrains Mono', Menlo, monospace;
  }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: var(--bg); padding: 40px 24px; }
  .page { max-width: 900px; margin: 0 auto; }
  .diff-block { background: var(--surface); border: 1.5px solid var(--border); border-radius: 12px; overflow: hidden; margin-bottom: 24px; }
  .diff-line { display: flex; font-family: var(--font-mono); font-size: 13px; line-height: 1.6; padding: 2px 16px; }
  .diff-line.add { background: #F0F7EC; border-left: 3px solid var(--olive); }
  .diff-line.del { background: #FDF2F0; border-left: 3px solid var(--rust); }
  .diff-line .ln { color: var(--muted); width: 40px; text-align: right; padding-right: 12px; flex-shrink: 0; }
  .severity { font-family: var(--font-mono); font-size: 10px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 999px; }
  .severity.critical { background: var(--rust); color: #fff; }
  .severity.warn { background: var(--accent); color: #fff; }
</style>
</head>
<body>
<div class="page">
  <h2>auth.js</h2>
  <div class="diff-block">
    <div class="diff-line del"><span class="ln">10</span>- const token = jwt.sign(payload, secret)</div>
    <div class="diff-line add"><span class="ln">10</span>+ const token = jwt.sign(payload, secret, { expiresIn: '1h' })</div>
  </div>
  <span class="severity critical">Critical</span>
  <span>Missing TTL — security risk</span>
</div>
</body>
</html>
```

## Example 3: Module Map

**File**: `04-code-understanding.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Architecture</title>
<style>
  :root { --bg: #FAF9F5; --fg: #141413; --border: #D1CFC5; --accent: #D97757; --olive: #788C5D; }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .page { max-width: 800px; margin: 0 auto; }
  svg { width: 100%; height: auto; }
  .node rect { fill: #fff; stroke: var(--border); stroke-width: 1.5; }
  .node.external rect { fill: none; stroke: var(--accent); stroke-dasharray: 4 4; }
  .node:hover rect { stroke: var(--fg); }
</style>
</head>
<body>
<div class="page">
  <svg viewBox="0 0 400 300">
    <defs>
      <marker id="arrow" markerWidth="10" markerHeight="10" refX="9" refY="3" orient="auto">
        <path d="M0,0 L0,6 L9,3 z" fill="var(--border)"/>
      </marker>
    </defs>
    <g class="node">
      <rect x="140" y="20" width="120" height="40" rx="6"/>
      <text x="200" y="45" text-anchor="middle" font-family="monospace" font-size="12">AuthService</text>
    </g>
    <g class="node">
      <rect x="140" y="100" width="120" height="40" rx="6"/>
      <text x="200" y="125" text-anchor="middle" font-family="monospace" font-size="12">UserService</text>
    </g>
    <line x1="200" y1="60" x2="200" y2="98" stroke="var(--border)" stroke-width="1.5" marker-end="url(#arrow)"/>
  </svg>
</div>
</body>
</html>
```

## Example 4: Design System

**File**: `05-design-system.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Design System</title>
<style>
  :root {
    --bg: #FAF9F5; --fg: #141413; --muted: #87867F; --border: #D1CFC5;
    --clay: #D97757; --olive: #788C5D; --rust: #B04A3F; --oat: #E3DACC;
    --font-mono: ui-monospace, 'JetBrains Mono', Menlo, monospace;
  }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .page { max-width: 900px; margin: 0 auto; }
  .swatch-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 16px; margin-bottom: 48px; }
  .swatch { border-radius: 8px; overflow: hidden; border: 1.5px solid var(--border); }
  .swatch .color { height: 80px; }
  .swatch .label { padding: 10px 12px; background: #fff; font-family: var(--font-mono); font-size: 12px; }
</style>
</head>
<body>
<div class="page">
  <h2>Colors</h2>
  <div class="swatch-grid">
    <div class="swatch"><div class="color" style="background:var(--clay)"></div><div class="label">--clay</div></div>
    <div class="swatch"><div class="color" style="background:var(--olive)"></div><div class="label">--olive</div></div>
    <div class="swatch"><div class="color" style="background:var(--rust)"></div><div class="label">--rust</div></div>
    <div class="swatch"><div class="color" style="background:var(--oat)"></div><div class="label">--oat</div></div>
  </div>
</div>
</body>
</html>
```

## Example 5: Slide Deck

**File**: `09-slide-deck.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Presentation</title>
<style>
  :root { --bg: #FAF9F5; --fg: #141413; --slate: #141413; --ivory: #FAF9F5; }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { scroll-snap-type: y mandatory; overflow-x: hidden; font-family: system-ui, sans-serif; }
  .slide { width: 100vw; height: 100vh; scroll-snap-align: start; scroll-snap-stop: always; display: flex; align-items: center; justify-content: center; padding: 8vh 6vw; }
  .slide.invert { background: var(--slate); color: var(--ivory); }
  h1 { font-size: clamp(40px, 6vw, 72px); font-weight: 500; letter-spacing: -0.02em; }
  .progress { position: fixed; bottom: 24px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; z-index: 100; }
  .progress .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--fg); opacity: 0.2; }
  .progress .dot.active { opacity: 1; }
</style>
</head>
<body>
<div class="slide"><h1>Title Slide</h1></div>
<div class="slide invert"><h1>Dark Slide</h1></div>
<div class="slide"><h1>Final Slide</h1></div>

<div class="progress">
  <div class="dot active"></div>
  <div class="dot"></div>
  <div class="dot"></div>
</div>

<script>
  const slides = document.querySelectorAll('.slide');
  const dots = document.querySelectorAll('.dot');
  const observer = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        const idx = [...slides].indexOf(entry.target);
        dots.forEach((d, i) => d.classList.toggle('active', i === idx));
      }
    });
  }, { threshold: 0.5 });
  slides.forEach(s => observer.observe(s));
</script>
</body>
</html>
```

## Example 6: Interactive Explainer

**File**: `15-research-concept-explainer.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Explainer</title>
<style>
  :root { --bg: #FAF9F5; --fg: #141413; --border: #D1CFC5; --accent: #D97757; }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .page { max-width: 800px; margin: 0 auto; }
  details { border: 1.5px solid var(--border); border-radius: 12px; padding: 16px 20px; margin-bottom: 12px; }
  summary { font-weight: 500; cursor: pointer; list-style: none; }
  summary::before { content: "▸"; margin-right: 8px; color: var(--accent); display: inline-block; transition: transform 150ms; }
  details[open] summary::before { transform: rotate(90deg); }
</style>
</head>
<body>
<div class="page">
  <h2>How It Works</h2>
  <details>
    <summary>Step 1: Initialization</summary>
    <p>The system loads configuration from...</p>
  </details>
  <details>
    <summary>Step 2: Processing</summary>
    <p>Data flows through the pipeline...</p>
  </details>
</div>
</body>
</html>
```

## Example 7: Status Report

**File**: `11-status-report.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Status</title>
<style>
  :root { --bg: #FAF9F5; --fg: #141413; --olive: #788C5D; --clay: #D97757; --rust: #B04A3F; }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .page { max-width: 900px; margin: 0 auto; }
  .health { display: inline-flex; align-items: center; gap: 6px; font-family: monospace; font-size: 11px; text-transform: uppercase; padding: 4px 10px; border-radius: 999px; }
  .health::before { content: ""; width: 6px; height: 6px; border-radius: 50%; }
  .health.on-track { background: #E8F0E0; color: var(--olive); }
  .health.on-track::before { background: var(--olive); }
  .health.at-risk { background: #F5E8E4; color: var(--clay); }
  .health.at-risk::before { background: var(--clay); }
  .bar-chart { display: flex; align-items: flex-end; gap: 8px; height: 120px; margin-top: 24px; }
  .bar { flex: 1; border-radius: 4px 4px 0 0; min-height: 4px; }
  .bar.done { background: var(--olive); }
  .bar.in-progress { background: var(--clay); }
</style>
</head>
<body>
<div class="page">
  <h2>Project Status</h2>
  <span class="health on-track">On Track</span>
  <div class="bar-chart">
    <div class="bar done" style="height:80%"></div>
    <div class="bar done" style="height:60%"></div>
    <div class="bar in-progress" style="height:40%"></div>
    <div class="bar" style="height:20%; background:#D1CFC5"></div>
  </div>
</div>
</body>
</html>
```

## Example 8: Flowchart

**File**: `13-flowchart-diagram.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Flowchart</title>
<style>
  :root { --bg: #FAF9F5; --fg: #141413; --border: #D1CFC5; --accent: #D97757; }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .page { max-width: 800px; margin: 0 auto; display: grid; grid-template-columns: 1fr 300px; gap: 40px; }
  svg { width: 100%; }
  .node { cursor: pointer; }
  .node:hover rect { stroke: var(--accent); }
  .detail { border: 1.5px solid var(--border); border-radius: 12px; padding: 20px; }
</style>
</head>
<body>
<div class="page">
  <svg viewBox="0 0 400 300">
    <g class="node" data-step="build">
      <rect x="100" y="100" width="120" height="50" rx="6" fill="#fff" stroke="var(--border)" stroke-width="1.5"/>
      <text x="160" y="130" text-anchor="middle" font-size="13">Build</text>
    </g>
  </svg>
  <div class="detail" id="details"><p>Click a step to see details</p></div>
</div>
<script>
  const details = { build: "<h3>Build</h3><p>Compiles source...</p>" };
  document.querySelectorAll('.node').forEach(node => {
    node.addEventListener('click', () => {
      document.getElementById('details').innerHTML = details[node.dataset.step];
    });
  });
</script>
</body>
</html>
```

## Example 9: Dashboard

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard</title>
<style>
  :root { --bg: #FAF9F5; --surface: #fff; --fg: #141413; --border: #D1CFC5; --clay: #D97757; --olive: #788C5D; --rust: #B04A3F; }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 24px; max-width: 1200px; margin: 0 auto; }
  .metric { background: var(--surface); border: 1.5px solid var(--border); border-radius: 12px; padding: 24px; }
  .metric .value { font-size: 42px; font-weight: 500; letter-spacing: -0.02em; }
  .metric .delta { font-family: monospace; font-size: 13px; }
  .metric .delta.up { color: var(--olive); }
  .metric .delta.down { color: var(--rust); }
  .sparkline { display: flex; align-items: flex-end; gap: 3px; height: 40px; margin-top: 16px; }
  .sparkline .bar { flex: 1; background: var(--border); border-radius: 2px 2px 0 0; }
  .sparkline .bar:last-child { background: var(--clay); }
</style>
</head>
<body>
<div class="grid">
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
</div>
</body>
</html>
```

## Example 10: Triage Board

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Triage</title>
<style>
  :root { --bg: #FAF9F5; --surface: #fff; --fg: #141413; --border: #D1CFC5; }
  body { margin: 0; background: var(--bg); font-family: system-ui, sans-serif; padding: 40px; }
  .board { display: grid; grid-template-columns: repeat(3, 1fr); gap: 24px; max-width: 1200px; margin: 0 auto; }
  .column { background: var(--surface); border: 1.5px solid var(--border); border-radius: 12px; padding: 20px; min-height: 400px; }
  .card { background: var(--bg); border: 1.5px solid var(--border); border-radius: 8px; padding: 16px; margin-bottom: 12px; cursor: grab; }
  .card.dragging { opacity: 0.5; }
  .column.drop-target { border-color: var(--fg); }
</style>
</head>
<body>
<div class="board">
  <div class="column" data-name="Todo"><h3>Todo</h3><div class="card" draggable="true" data-id="1">Task 1</div></div>
  <div class="column" data-name="Doing"><h3>Doing</h3></div>
  <div class="column" data-name="Done"><h3>Done</h3></div>
</div>
<script>
  document.querySelectorAll('.card').forEach(card => {
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
  });
  document.querySelectorAll('.column').forEach(col => {
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drop-target'); });
    col.addEventListener('dragleave', () => col.classList.remove('drop-target'));
    col.addEventListener('drop', (e) => {
      e.preventDefault();
      col.classList.remove('drop-target');
      const id = e.dataTransfer.getData('text/plain');
      col.appendChild(document.querySelector(`[data-id="${id}"]`));
    });
  });
</script>
</body>
</html>
```

## Example 11: Refreshable Dashboard (Pattern #12)

**File**: `22-refreshable-dashboard.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Refreshable Dashboard</title>
<style>
  :root {
    --bg: #FAF9F5; --surface: #FFFFFF; --fg: #141413; --muted: #87867F;
    --border: #D1CFC5; --accent: #D97757; --olive: #788C5D; --rust: #B04A3F; --clay: #D97757;
    --gap: 24px; --gap-xl: 48px; --radius-panel: 14px;
    --serif: 'Iowan Old Style', 'Charter', Georgia, serif;
    --mono: ui-monospace, 'JetBrains Mono', Menlo, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--fg); line-height: 1.55; padding: 48px 24px; }
  .page { max-width: 1200px; margin: 0 auto; }

  h1 { font-family: var(--serif); font-size: clamp(32px, 4vw, 48px); font-weight: 500; letter-spacing: -0.02em; margin: 0 0 8px; }
  .subtitle { color: var(--muted); font-size: 16px; margin-bottom: 32px; }

  .dashboard-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: var(--gap);
    margin-bottom: var(--gap-xl);
  }
  @media (max-width: 920px) { .dashboard-grid { grid-template-columns: repeat(2, 1fr); } }
  @media (max-width: 520px) { .dashboard-grid { grid-template-columns: 1fr; } }

  .metric-card {
    background: var(--surface);
    border: 1.5px solid var(--border);
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

  .sparkline {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 36px;
    margin-top: 16px;
  }
  .sparkline .bar {
    flex: 1;
    background: var(--border);
    border-radius: 2px 2px 0 0;
    transition: height 300ms ease;
  }
  .sparkline .bar:last-child { background: var(--clay); }

  .top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 32px;
    flex-wrap: wrap;
    gap: 16px;
  }
  .refresh-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-family: var(--mono);
    font-size: 11px;
    color: var(--muted);
    padding: 6px 12px;
    border: 1.5px solid var(--border);
    border-radius: 999px;
    cursor: pointer;
    transition: all 150ms ease;
    background: none;
  }
  .refresh-badge:hover { border-color: var(--accent); color: var(--accent); }
  .refresh-badge .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--olive); transition: background 200ms; }
  .refresh-badge .dot.stale { background: var(--clay); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }

  .updated-at {
    font-family: var(--mono);
    font-size: 12px;
    color: var(--muted);
  }
</style>
</head>
<body>
<div class="page">
  <div class="top-bar">
    <div>
      <h1>Dashboard</h1>
      <p class="subtitle">Key metrics at a glance</p>
    </div>
    <button class="refresh-badge" id="refreshBtn">
      <span class="dot" id="statusDot"></span>
      <span>Live</span>
    </button>
  </div>

  <div class="dashboard-grid" id="dashboard"></div>
  <p class="updated-at" id="timestamp"></p>
</div>

<script>
  const metrics = [
    { id: 'revenue', label: 'Monthly Revenue',    value: '$128,430', delta: '+12.4%', trend: 'up',   sparkline: [0.2, 0.3, 0.45, 0.35, 0.6,  0.5,  0.75, 0.65, 0.9,  1] },
    { id: 'users',   label: 'Active Users',        value: '8,249',    delta: '+3.2%',  trend: 'up',   sparkline: [0.4, 0.5, 0.45, 0.6,  0.55, 0.7,  0.65, 0.8,  0.85, 1] },
    { id: 'churn',   label: 'Churn Rate',          value: '2.1%',    delta: '-0.3%',  trend: 'down', sparkline: [0.8, 0.9, 0.75, 0.7,  0.6,  0.55, 0.5,  0.45, 0.35, 0.3] },
    { id: 'nps',     label: 'Net Promoter Score', value: '72',      delta: '+4.8',   trend: 'up',   sparkline: [0.5, 0.55,0.6,  0.65, 0.7,  0.75, 0.8,  0.85, 0.9,  1] }
  ];

  function renderCards(data) {
    const grid = document.getElementById('dashboard');
    grid.innerHTML = data.map(m => `
      <div class="metric-card">
        <span class="label">${m.label}</span>
        <span class="value">${m.value}</span>
        <span class="delta ${m.trend}">${m.delta}</span>
        <div class="sparkline">
          ${m.sparkline.map(h => `<div class="bar" style="height:${h * 100}%"></div>`).join('')}
        </div>
      </div>
    `).join('');
    const now = new Date();
    document.getElementById('timestamp').textContent =
      `Last updated: ${now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}`;
  }

  document.getElementById('refreshBtn').addEventListener('click', () => {
    const dot = document.getElementById('statusDot');
    dot.classList.add('stale');
    setTimeout(() => {
      metrics.forEach(m => {
        m.delta = (parseFloat(m.delta) + (Math.random() - 0.5) * 0.6).toFixed(1) + (m.id === 'churn' ? '%' : '%');
        m.trend = parseFloat(m.delta) >= 0 ? 'up' : 'down';
      });
      renderCards(metrics);
      dot.classList.remove('stale');
    }, 800);
  });

  renderCards(metrics);
</script>
</body>
</html>
```

## Example 12: Glitch Hero (Pattern #13)

**File**: `23-frame-effects.html`

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Glitch Hero</title>
<style>
  :root {
    --bg: #0F0F0F; --fg: #E3DACC; --surface: #1A1A1A; --muted: #6B6B66;
    --border: #2A2A26; --accent: #D97757; --olive: #788C5D; --oat: #E3DACC;
    --serif: 'Iowan Old Style', 'Charter', Georgia, serif;
    --mono: ui-monospace, 'JetBrains Mono', Menlo, monospace;
  }
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--fg); min-height: 100vh; overflow-x: hidden; }

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
    color: var(--fg);
    display: inline-block;
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

  /* Liquid Background */
  @keyframes liquid-morph {
    0%, 100% { border-radius: 60% 40% 30% 70% / 60% 30% 70% 40%; }
    25%      { border-radius: 30% 60% 70% 40% / 50% 60% 30% 60%; }
    50%      { border-radius: 50% 50% 50% 70% / 50% 40% 70% 60%; }
    75%      { border-radius: 40% 60% 30% 50% / 70% 40% 60% 50%; }
  }
  .liquid-bg { position: relative; overflow: hidden; }
  .liquid-bg::before {
    content: '';
    position: absolute;
    width: 140%; height: 140%;
    top: -20%; left: -20%;
    background: linear-gradient(135deg, var(--accent), var(--olive), var(--oat));
    opacity: 0.15;
    animation: liquid-morph 8s ease-in-out infinite;
    z-index: 0;
  }

  /* Cinema Light Leak */
  @keyframes light-leak {
    0%, 90%, 100% { opacity: 0; }
    95% { opacity: 0.08; }
  }
  .cinema-frame { position: relative; }
  .cinema-frame::after {
    content: '';
    position: absolute;
    inset: 0;
    background: linear-gradient(135deg, transparent 40%, rgba(255,200,100,.15) 50%, transparent 60%);
    pointer-events: none;
    animation: light-leak 6s ease-in-out infinite;
    z-index: 100;
  }

  /* Entry Animations */
  .anim-fade-up { opacity: 0; transform: translateY(24px); animation: fade-up 0.6s cubic-bezier(0.23,1,0.32,1) forwards; }
  @keyframes fade-up { to { opacity: 1; transform: translateY(0); } }
  .anim-stagger > * { opacity: 0; animation: fade-up 0.5s cubic-bezier(0.23,1,0.32,1) forwards; }
  .anim-stagger > *:nth-child(1) { animation-delay: 0s; }
  .anim-stagger > *:nth-child(2) { animation-delay: 0.1s; }
  .anim-stagger > *:nth-child(3) { animation-delay: 0.2s; }
  .anim-stagger > *:nth-child(4) { animation-delay: 0.3s; }
  .anim-stagger > *:nth-child(5) { animation-delay: 0.4s; }

  /* Layout */
  .hero {
    position: relative;
    min-height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 8vh 6vw;
    text-align: center;
  }
  .tagline {
    font-family: var(--mono);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: var(--accent);
    margin-bottom: 24px;
  }
  .description { max-width: 600px; font-size: 18px; line-height: 1.7; color: var(--muted); margin-top: 32px; }
  .cta {
    margin-top: 48px;
    font-family: var(--mono);
    font-size: 14px;
    padding: 14px 32px;
    border: 1.5px solid var(--fg);
    border-radius: 999px;
    background: transparent;
    color: var(--fg);
    cursor: pointer;
    transition: all 200ms ease;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .cta:hover { background: var(--fg); color: var(--bg); }
</style>
</head>
<body>
<div class="hero liquid-bg cinema-frame">
  <span class="tagline anim-fade-up">Creative Technology</span>
  <h1 class="glitch-title anim-fade-up" data-text="BREAK THROUGH">BREAK THROUGH</h1>
  <div class="description anim-stagger">
    <p>Where design meets engineering. We craft digital experiences that push boundaries and redefine what's possible on the web.</p>
    <p>Every pixel matters. Every frame counts.</p>
  </div>
  <button class="cta anim-fade-up" style="animation-delay:0.6s">Explore Work</button>
</div>
</body>
</html>
```
