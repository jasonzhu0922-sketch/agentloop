---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_d0e5b8f573c711f1b2f55254006c9bbf
    ReservedCode1: DJX8xLZ+3ipnaFGFHysKTLWr08AklECrAPwTQ3TceqDZ56bDWGBso+mKR/fOdP0ml2V+/6/rtOE8Sfei7s5gC+KkenjhhwhMmPLpJUEfZXCBkdi0kGqryFF0sCBtoE4eu5uypCUfNtxAxmxN1jNpQY+H36dtm9YBhSQQfkjfXVINnNCjy46Hcpbvy+g=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_d0e5b8f573c711f1b2f55254006c9bbf
    ReservedCode2: DJX8xLZ+3ipnaFGFHysKTLWr08AklECrAPwTQ3TceqDZ56bDWGBso+mKR/fOdP0ml2V+/6/rtOE8Sfei7s5gC+KkenjhhwhMmPLpJUEfZXCBkdi0kGqryFF0sCBtoE4eu5uypCUfNtxAxmxN1jNpQY+H36dtm9YBhSQQfkjfXVINnNCjy46Hcpbvy+g=
---

# Presenter Mode · BroadcastChannel 双窗口演讲者模式

为 Pattern #5 Slide Deck 提供演讲者模式支持。双窗口架构：主窗口（观众视角）+ 演讲者窗口（按 S 弹出）。

## Core Mechanism / 核心机制

使用 `BroadcastChannel` API 在主窗口和演讲者窗口间同步当前幻灯片索引。

```
User presses S → Open presenter window → BroadcastChannel syncs slide index
```

## HTML Structure / HTML 结构

每一张幻灯片可以包含演讲者备注：

```html
<section class="slide" data-slide="1">
  <h1>Slide Title</h1>
  <p>Visible content...</p>
  <aside class="notes">
    Speaker-only notes: 150-300 words of script.
    Key points to cover, timing hints, transition cues.
  </aside>
</section>
```

## JavaScript Implementation / JavaScript 实现

```javascript
// Main window — broadcast current slide
let currentSlide = 0;
const channel = typeof BroadcastChannel !== 'undefined'
  ? new BroadcastChannel('slide-sync')
  : null;

function updateSlide(index) {
  currentSlide = index;
  if (channel) {
    channel.postMessage({ slide: index, notes: getNotesForSlide(index) });
  }
}

function getNotesForSlide(index) {
  const slide = document.querySelector(`[data-slide="${index}"]`);
  const notes = slide?.querySelector('.notes');
  return notes?.textContent || '';
}

// Open presenter window on S key
document.addEventListener('keydown', (e) => {
  if (e.key === 's' || e.key === 'S') {
    window.open('presenter.html', 'presenter', 'width=1200,height=800');
  }
});
```

### Presenter Window / 演讲者窗口

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Presenter View</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    background: #0f0f0f;
    color: #f0f0f0;
    display: grid;
    grid-template-columns: 1fr 1fr;
    grid-template-rows: auto 1fr 1fr auto;
    height: 100vh;
    gap: 12px;
    padding: 16px;
  }
  .current-slide {
    grid-column: 1 / -1;
    background: #1a1a1a;
    border-radius: 8px;
    padding: 16px;
    min-height: 200px;
  }
  .next-slide {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 16px;
  }
  .script {
    background: #1a1a1a;
    border-radius: 8px;
    padding: 16px;
    overflow-y: auto;
  }
  .timer-bar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 24px;
    font-variant-numeric: tabular-nums;
  }
  .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #888;
    margin-bottom: 8px;
  }
  iframe {
    width: 100%;
    height: calc(100% - 24px);
    border: none;
    border-radius: 4px;
  }
</style>
</head>
<body>
  <div class="current-slide">
    <div class="label">Current Slide / 当前页</div>
    <iframe id="current-frame"></iframe>
  </div>
  <div class="next-slide">
    <div class="label">Next Slide / 下一页</div>
    <iframe id="next-frame"></iframe>
  </div>
  <div class="script">
    <div class="label">Speaker Notes / 逐字稿</div>
    <div id="notes-content"></div>
  </div>
  <div class="timer-bar">
    <span id="timer">00:00</span>
    <span style="color: #888;">| Slide <span id="slide-num">1</span></span>
  </div>
</body>
<script>
const channel = new BroadcastChannel('slide-sync');
const startTime = Date.now();

channel.onmessage = (e) => {
  const { slide, notes } = e.data;
  document.getElementById('slide-num').textContent = slide;
  document.getElementById('notes-content').textContent = notes || 'No notes for this slide.';
  document.getElementById('current-frame').src = `main.html#slide-${slide}`;
  document.getElementById('next-frame').src = `main.html#slide-${slide + 1}`;
};

// Timer
setInterval(() => {
  const elapsed = Math.floor((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
  const secs = (elapsed % 60).toString().padStart(2, '0');
  document.getElementById('timer').textContent = `${mins}:${secs}`;

  // Warning flash after 15 min
  if (elapsed > 900 && !document.body.classList.contains('warning')) {
    document.body.classList.add('warning');
  }
}, 1000);
</script>
</html>
```

## CSS for Presenter View Styling / 演讲者窗口样式补充

```css
/* Timer warning state */
.warning .timer-bar {
  color: #ff6b6b;
  animation: pulse-warn 1s ease-in-out infinite alternate;
}
@keyframes pulse-warn {
  from { opacity: 1; }
  to { opacity: 0.6; }
}

/* Notes text styling */
#notes-content {
  font-size: 16px;
  line-height: 1.6;
  color: #d0d0d0;
  white-space: pre-wrap;
}
```

## Key Points / 关键注意事项

- BroadcastChannel same-origin requirement: presenter window must be opened from same origin.
- Notes content `<aside class="notes">` is hidden from main view via CSS (`display: none` in main, `display: block` in presenter).
- Timer auto-starts on presenter window open; 15-minute warning flash after elapsed > 900s.
- Iframe approach preserves slide CSS from main document without duplication.
*（内容由AI生成，仅供参考）*
