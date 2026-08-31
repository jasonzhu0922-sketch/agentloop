---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_cebac26673c711f1986d525400d9a7a1
    ReservedCode1: Lagx79qAEEoiOutqRW8cM6PNaPiL1bZ7utbRaLWZs3d7AzUgoU1ROAQKytfRhmkt+DfKWhK41gxW9gedTbG3j3UZR1Ub1DIW4xYiS4JEMN2AHPYVU3MniarfRqF6KGB5kn0Y/Nf/zwJ0EGa7Njgg7WnMLfg8MpREtaKwvFx1B0kf1Fe4zxTsj6jookE=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_cebac26673c711f1986d525400d9a7a1
    ReservedCode2: Lagx79qAEEoiOutqRW8cM6PNaPiL1bZ7utbRaLWZs3d7AzUgoU1ROAQKytfRhmkt+DfKWhK41gxW9gedTbG3j3UZR1Ub1DIW4xYiS4JEMN2AHPYVU3MniarfRqF6KGB5kn0Y/Nf/zwJ0EGa7Njgg7WnMLfg8MpREtaKwvFx1B0kf1Fe4zxTsj6jookE=
---

# Palette Examples · 完整色板参考

从 SKILL.md v3.0 迁移的完整 16 色调色板及 4 套替代配色方案。核心 Skill 仅保留 6 令牌系统，完整色板供需要扩展调色板的场景参考。

## Default Palette / 默认色板

```css
:root {
  --ivory:    #FAF9F5;  /* page background */
  --slate:    #141413;  /* primary text, headings */
  --clay:     #D97757;  /* accent, links, CTAs, active states */
  --clay-d:   #B85C3E;  /* accent hover / dark variant */
  --oat:      #E3DACC;  /* secondary accent, borders, highlights */
  --olive:    #788C5D;  /* success, positive, secondary action */
  --rust:     #B04A3F;  /* error, warning, destructive */
  --sky:      #6A8CAF;  /* info, tertiary accent (optional) */
  --gray-50:  #F0EEE6;  /* subtle backgrounds, tags */
  --gray-100: #F0EEE6;  /* card backgrounds, code blocks */
  --gray-150: #F0EEE6;  /* prompt boxes, subtle fills */
  --gray-200: #D1CFC5;  /* borders, dividers */
  --gray-300: #D1CFC5;  /* card borders, separators */
  --gray-500: #87867F;  /* muted text, captions, meta */
  --gray-700: #3D3D3A;  /* body text, descriptions */
  --gray-800: #3D3D3A;  /* secondary headings */
  --white:    #FFFFFF;  /* card backgrounds, panels */
}
```

| Token | Hex | Role |
|-------|-----|------|
| `--ivory` | `#FAF9F5` | Page background |
| `--slate` | `#141413` | Primary text, headings |
| `--clay` | `#D97757` | Accent, links, CTAs |
| `--clay-d` | `#B85C3E` | Accent hover |
| `--oat` | `#E3DACC` | Secondary accent, borders |
| `--olive` | `#788C5D` | Success, positive |
| `--rust` | `#B04A3F` | Error, destructive |
| `--sky` | `#6A8CAF` | Info, tertiary (optional) |
| `--gray-50` | `#F0EEE6` | Subtle backgrounds |
| `--gray-200` | `#D1CFC5` | Borders, dividers |
| `--gray-500` | `#87867F` | Muted text |
| `--gray-700` | `#3D3D3A` | Body text |
| `--white` | `#FFFFFF` | Card backgrounds |

---

## Alternative Palettes / 替代方案

### 1. Dark / Luxury · 暗黑 / 奢华

```css
:root {
  --bg:      #0a0a0a;
  --surface: #141414;
  --fg:      #e5e5e5;
  --muted:   #888888;
  --border:  #2a2a2a;
  --accent:  #c9a96e;  /* gold */
}
```

**Use for**: Premium brand pages, luxury product showcases, editorial dark mode.

**用于**: 高端品牌页、奢侈品展示、编辑类暗色模式。

---

### 2. Soft / Pastel · 柔和 / 粉彩

```css
:root {
  --bg:      #f5f0ff;
  --surface: #faf7ff;
  --fg:      #2d2a32;
  --muted:   #7a7585;
  --border:  #e8e0f0;
  --accent:  #9b7ede;  /* lavender */
}
```

**Use for**: Wellness, creative portfolios, educational content.

**用于**: 健康类、创意作品集、教育内容。

---

### 3. Brutalist · 粗野主义

```css
:root {
  --bg:      #ffffff;
  --surface: #f5f5f5;
  --fg:      #000000;
  --muted:   #555555;
  --border:  #000000;
  --accent:  #ff0000;  /* pure red */
}
```

**Use for**: Experimental design, developer tools, anti-design statements.

**用于**: 实验性设计、开发者工具、反设计声明。

---

### 4. Industrial · 工业风

```css
:root {
  --bg:      #e8e6e1;
  --surface: #f0eeea;
  --fg:      #1a1a1a;
  --muted:   #6b6862;
  --border:  #c5c1b9;
  --accent:  #d4652a;  /* rust orange */
}
```

**Use for**: Engineering docs, hardware products, utilitarian interfaces.

**用于**: 工程文档、硬件产品、实用主义界面。

---

## Usage Notes / 使用说明

- Default palette is warm editorial style, suitable for most documentation and report scenarios.
- Each alternative replaces the 6 core tokens; all `color-mix()` derivations will adapt automatically.
- In v3.0, the core SKILL.md only retains the 6-token system. These full palettes are preserved here for reference when extended color systems are needed.

- 默认色板为暖色调编辑风格，适合多数文档和报告场景。
- 每套替代方案替换 6 个核心令牌，所有 `color-mix()` 派生将自动适配。
- v3.0 中核心 SKILL.md 仅保留 6 令牌系统，完整色板保留于此供需要扩展色彩系统时参考。
*（内容由AI生成，仅供参考）*
