---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 263ae02d9b82b898f7b6446bc49bf3dd_cfd4038573c711f1b2f55254006c9bbf
    ReservedCode1: +71x70HQyhaaSxWOgOzn318FMZk8CUT8xDh5AWKK68EHIwKakn6dFitHz4pIrQy0gZEBIMUdzguImHbwD+ibN2ugjAmR54kFdC0usvPFPkv2vOUq4PeB56YHToS7SPUH9gQA+sspEZifdbAWAupZVdlxxV1PS7oIjfj++TbbNXIVPj9f7Z1aexx/Ipo=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 263ae02d9b82b898f7b6446bc49bf3dd_cfd4038573c711f1b2f55254006c9bbf
    ReservedCode2: +71x70HQyhaaSxWOgOzn318FMZk8CUT8xDh5AWKK68EHIwKakn6dFitHz4pIrQy0gZEBIMUdzguImHbwD+ibN2ugjAmR54kFdC0usvPFPkv2vOUq4PeB56YHToS7SPUH9gQA+sspEZifdbAWAupZVdlxxV1PS7oIjfj++TbbNXIVPj9f7Z1aexx/Ipo=
---

# Style Recipes · 美学方向 × 品牌参照

美学方向与真实品牌参照的映射表，含配色倾向和字体风格建议。为 Step 1 美学方向选择提供品牌锚定。

## Mapping Table / 映射表

| 美学方向 | 品牌参照 | 配色倾向 | 字体风格 |
|----------|---------|---------|---------|
| Editorial / Magazine | Monocle, Kinfolk | 温暖中性色 + 单一强调色 | 衬线展示体 (Iowan Old Style / Charter) |
| Brutalist / Raw | Balenciaga, Vitsoe | 黑白高对比 + 单色强调 | 无衬线粗体 (Helvetica Neue Bold) |
| Luxury / Refined | Hermès, Aesop | 深色 + 金色/琥珀强调 | 优雅衬线 (Cormorant Garamond) |
| Minimalist / Swiss | Muji, Apple (early) | 白灰为主 + 极简强调色 | 无衬线 (SF Pro / Helvetica) |
| Maximalist / Chaos | MSCHF, Supreme | 高饱和多色碰撞 | 粗体展示体 + 多种字重混搭 |
| Retro-Futuristic | Retrosuperfuture, NASA (brand) | 深色底 + 霓虹强调 | 等宽展示体 (Space Mono) |
| Organic / Natural | Patagonia, Aesop | 大地色系 + 暖白/米色 | 人文主义衬线 (Lora / Merriweather) |
| Playful / Toy-Like | Lego, Nintendo | 高饱和原色 | 圆体/卡通体 (Baloo 2 / Nunito) |
| Art Deco / Geometric | Great Gatsby (film), Chrysler | 金/黑/白 + 几何线条 | 装饰性衬线 (Playfair Display) |
| Soft / Pastel | Glossier, & Other Stories | 柔粉/薰衣草 + 灰调 | 轻量无衬线 (DM Sans) |
| Industrial / Utilitarian | Vitsoe, Muji (later) | 灰/白 + 系统强调色 | 等宽/工业字体 (IBM Plex Mono) |
| Academic / Scholarly | Oxford University Press, MIT Press | 中性色 + 深蓝/酒红强调 | 学术衬线 (Georgia / Times New Roman) |
| Tech / Developer | Vercel, Linear | 深色 + 单一强调色（非靛蓝） | 等宽代码体 (JetBrains Mono) |

## Color Tendency Details / 配色倾向详解

### Editorial / Magazine
- `--bg`: warm off-white (#fafaf5-#fafaf7)
- `--accent`: terracotta / clay / warm red
- Low saturation, single dominant accent

### Brutalist / Raw
- `--bg`: pure white (#ffffff)
- `--fg`: pure black (#000000)
- `--accent`: single aggressive color (red / orange)
- No gradients, no shadows, no rounded corners

### Luxury / Refined
- `--bg`: near-black (#0a0a0a）or warm cream (#f9f6f0)
- `--accent`: gold (#c9a96e）or amber (#b8944a)
- Generous whitespace, thin borders

### Minimalist / Swiss
- `--bg`: white or light gray
- `--fg`: near-black
- `--accent`: one subtle color, used sparingly
- Grid-based layout, asymmetric balance

---

## Font Pairing Suggestions / 字体配对建议

| 美学方向 | Display | Body | Code |
|----------|---------|------|------|
| Editorial | Iowan Old Style, Charter | -apple-system | JetBrains Mono |
| Brutalist | Helvetica Neue Bold | system-ui | SF Mono |
| Luxury | Cormorant Garamond | Work Sans | JetBrains Mono |
| Minimalist | SF Pro Display | SF Pro Text | SF Mono |
| Tech | Space Grotesk | IBM Plex Sans | JetBrains Mono |
| Academic | Georgia | system-serif | ui-monospace |

---

## Usage / 使用

In SKILL.md Step 1, when the user does not specify an aesthetic direction, pick one based on content type:

- **Documentation / Reports** → Editorial / Magazine
- **Developer Tools** → Tech / Developer
- **Creative Portfolios** → Organic / Natural or Playful
- **Enterprise** → Minimalist / Swiss
- **Fashion / Lifestyle** → Luxury / Refined

When the user specifies a direction, use this table to select matching color and font recipes.
*（内容由AI生成，仅供参考）*
