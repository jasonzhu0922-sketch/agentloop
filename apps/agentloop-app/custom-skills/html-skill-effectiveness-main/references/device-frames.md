---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_d3fcfb5473c711f1b2f55254006c9bbf
    ReservedCode1: k9KFuwhRdf4qSPGs2WK9ntv+nyRFhZaoJifoyHTxIuud8G40J0sl6VdhKIP86hgom5eikhhcy3Q6NNtyttTgh0MxF85DcEpvkiMXqaWLdW/a2vnlaJKSuCHKW9o8tJ01+icExx8Dg4MkmZjCGPWdDD5QiOGt3OjPBbNQV2smm6c8UjyYeWl3jkJy3HM=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_d3fcfb5473c711f1b2f55254006c9bbf
    ReservedCode2: k9KFuwhRdf4qSPGs2WK9ntv+nyRFhZaoJifoyHTxIuud8G40J0sl6VdhKIP86hgom5eikhhcy3Q6NNtyttTgh0MxF85DcEpvkiMXqaWLdW/a2vnlaJKSuCHKW9o8tJ01+icExx8Dg4MkmZjCGPWdDD5QiOGt3OjPBbNQV2smm6c8UjyYeWl3jkJy3HM=
---

# Device Frames · CSS 设备外框

纯 CSS 实现的设备外框代码，用于在 HTML 页面中展示移动端/桌面端 mockup。

---

## iPhone 15 Pro

```html
<div class="device-iphone-15-pro">
  <div class="device-screen">
    <iframe src="your-content.html"></iframe>
  </div>
</div>
```

```css
.device-iphone-15-pro {
  --device-width: 393px;
  --device-height: 852px;
  --device-radius: 55px;
  --notch-width: 126px;
  --notch-height: 36px;

  width: var(--device-width);
  height: var(--device-height);
  background: #1a1a1a;
  border-radius: var(--device-radius);
  padding: 12px;
  position: relative;
  box-shadow:
    0 0 0 2px #2a2a2a,
    0 0 0 4px #1a1a1a,
    0 20px 60px rgba(0, 0, 0, 0.3);
}

.device-iphone-15-pro::before {
  content: '';
  position: absolute;
  top: 12px;
  left: 50%;
  transform: translateX(-50%);
  width: var(--notch-width);
  height: var(--notch-height);
  background: #0a0a0a;
  border-radius: 0 0 20px 20px;
  z-index: 2;
}

.device-iphone-15-pro .device-screen {
  width: 100%;
  height: 100%;
  border-radius: calc(var(--device-radius) - 12px);
  overflow: hidden;
  background: #fafaf7;
}

.device-iphone-15-pro .device-screen iframe {
  width: 100%;
  height: 100%;
  border: none;
}

/* Status bar */
.device-iphone-15-pro::after {
  content: '9:41';
  position: absolute;
  top: 18px;
  left: 36px;
  font-family: -apple-system, sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: #f0f0f0;
  z-index: 3;
  letter-spacing: 0.02em;
}

/* Responsive: scale down on small viewports */
@media (max-width: 500px) {
  .device-iphone-15-pro {
    transform: scale(0.75);
    transform-origin: top center;
  }
}
```

---

## MacBook Air (M2)

```css
.device-macbook-air {
  --device-width: 1280px;
  --device-height: 820px;
  --lid-height: 40px;
  --base-height: 20px;

  position: relative;
  width: var(--device-width);
  background: #d4d2cc;
  border-radius: 12px 12px 0 0;
  padding: 48px 64px 0;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.15);
}

.device-macbook-air::before {
  content: '';
  display: block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #1a1a1a;
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
}

.device-macbook-air .device-screen {
  width: 100%;
  aspect-ratio: 16 / 10;
  background: #fafaf7;
  border-radius: 8px;
  border: 2px solid #2a2a2a;
  overflow: hidden;
}

.device-macbook-air .device-screen iframe {
  width: 100%;
  height: 100%;
  border: none;
}

.device-macbook-air::after {
  content: '';
  display: block;
  width: 100%;
  height: var(--lid-height);
  background: #d4d2cc;
  position: absolute;
  bottom: calc(-1 * var(--lid-height));
  left: 0;
  border-radius: 0 0 12px 12px;
  box-shadow: 0 4px 8px rgba(0, 0, 0, 0.1);
}

/* Base (keyboard deck) */
.device-macbook-air-wrapper {
  position: relative;
}

.device-macbook-air-wrapper::after {
  content: '';
  display: block;
  width: 1360px;
  height: var(--base-height);
  background: #d4d2cc;
  border-radius: 0 0 8px 8px;
  margin-left: -40px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* Responsive scale */
@media (max-width: 1400px) {
  .device-macbook-air {
    transform: scale(0.65);
    transform-origin: top center;
  }
}
@media (max-width: 900px) {
  .device-macbook-air {
    transform: scale(0.4);
    transform-origin: top center;
  }
}
```

---

## iPad Pro 11"

```css
.device-ipad-pro {
  --device-width: 834px;
  --device-height: 1194px;
  --device-radius: 20px;

  width: var(--device-width);
  height: var(--device-height);
  background: #1a1a1a;
  border-radius: var(--device-radius);
  padding: 14px;
  position: relative;
  box-shadow:
    0 0 0 2px #2a2a2a,
    0 20px 50px rgba(0, 0, 0, 0.2);
}

.device-ipad-pro .device-screen {
  width: 100%;
  height: 100%;
  border-radius: calc(var(--device-radius) - 4px);
  overflow: hidden;
  background: #fafaf7;
}

.device-ipad-pro .device-screen iframe {
  width: 100%;
  height: 100%;
  border: none;
}

/* Camera dot */
.device-ipad-pro::before {
  content: '';
  position: absolute;
  top: 22px;
  left: 50%;
  transform: translateX(-50%);
  width: 10px;
  height: 10px;
  background: #0a0a0a;
  border-radius: 50%;
  z-index: 2;
}

/* Responsive */
@media (max-width: 950px) {
  .device-ipad-pro {
    transform: scale(0.6);
    transform-origin: top center;
  }
}
@media (max-width: 550px) {
  .device-ipad-pro {
    transform: scale(0.4);
    transform-origin: top center;
  }
}
```

---

## Shared Utility / 共用样式

```css
/* Device container centering */
.device-container {
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: 40px 0;
  overflow: hidden;
}

/* Light theme variant */
.device-light {
  background: #e8e5df;
}
.device-light::before {
  background: #d1cfc5;
}

/* Dark theme variant */
.device-dark {
  background: #0a0a0a;
}
```

## Usage Example / 使用示例

```html
<!-- iPhone mockup -->
<div class="device-container">
  <div class="device-iphone-15-pro">
    <div class="device-screen">
      <iframe src="mobile-landing.html" title="Mobile Preview"></iframe>
    </div>
  </div>
</div>

<!-- MacBook mockup -->
<div class="device-container">
  <div class="device-macbook-air-wrapper">
    <div class="device-macbook-air">
      <div class="device-screen">
        <iframe src="desktop-dashboard.html" title="Desktop Preview"></iframe>
      </div>
    </div>
  </div>
</div>
```

## Notes / 注意事项

- All frames are pure CSS — no images, no external assets.
- Device dimensions match actual product specs (iPhone 15 Pro: 393×852 CSS px).
- Use `iframe` for embedding arbitrary content; use direct HTML for inline mockups.
- Always add `transform: scale()` for responsive scaling; don't hardcode media queries if using container queries.
- All mockups use system colors that harmonize with the 6-token design system.
*（内容由AI生成，仅供参考）*
