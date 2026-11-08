# TrustLayer design tokens (dealt by the tasteskill run, 2026-11-08)

- Kind: software (developer tool). Palette `white-link-blue` (white ground, one blue accent #1a4be0: the ink-and-biro look of a developer's sheet, no violet).
- Type pairing `host`: Host Grotesk (display 500, text 400/500) + JetBrains Mono.
- Radius `sharp` (4/6/8). Buttons `pill`. Lit ground `sand` (behind product UI). Mark `stack`.
- Hero triptych, nav-centre, close-word, footer-columns, rhythm space; effect gradient-mesh (one frame); moment liquid-type.

## Head (copy into app.html)

```html
<html lang="en" data-type="software" data-radius="sharp" data-ground="sand" data-buttons="pill" data-motion>
<meta name="site-kind" content="software"><meta name="page-type" content="software">
<link rel="icon" href="favicon.svg" type="image/svg+xml"><meta name="theme-color" content="#ffffff">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Host+Grotesk:wght@400..700&family=JetBrains+Mono:wght@400..500&display=swap" rel="stylesheet">
<link rel="stylesheet" href="assets/system.css">
<link rel="stylesheet" href="assets/ui/cards.css">
<link rel="stylesheet" href="assets/motion/motion.css">
<link rel="stylesheet" href="assets/backgrounds/backgrounds.css">
<link rel="stylesheet" href="assets/layout/layout.css">
<link rel="stylesheet" href="assets/icons/icon.css">
<link rel="stylesheet" href="assets/trustlayer.css">   <!-- the :root tokens below; must come after layout.css -->
<link rel="stylesheet" href="assets/ui/base.css">       <!-- optional: product UI fragments (.ui, .ui-panel ...) -->
<!-- end of body -->
<script type="module" src="assets/system.js"></script>
<script type="module" src="assets/motion/motion.js"></script>
```
Page-specific CSS goes in its own file (the landing uses `assets/landing.css`; its `.tl-st--ok/--no` status chips and `.app` frame rules can be reused).
Nav markup: `header.nav.nav--centre > .wrap.nav__bar` with `.nav__logo` (`<span class="mark" data-mark="stack">`), `.btn.btn--primary`.

## :root (exactly as printed by start.mjs; in assets/trustlayer.css)

```css
:root {
  --p-bg: #ffffff; --p-surface: #f4f4f4; --p-ink: #111111; --p-muted: #6b6b6b;
  --p-accent: #1a4be0; --p-accent-ink: #ffffff; --p-action: #1a4be0; --p-action-ink: #ffffff;
  --p-inv-bg: #111111; --p-inv-surface: #1e1e1e; --p-inv-ink: #ffffff; --p-inv-muted: #9a9a9a;
  --p-inv-accent: #ffffff; --p-inv-accent-ink: #111111; --p-inv-action: #ffffff; --p-inv-action-ink: #111111;
  --font-display: "Host Grotesk", system-ui, sans-serif;
  --font-text: "Host Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
  --display-weight: 500;
  --display-tracking: -0.035em;
  --display-tracking-xl: -0.04em;
  /* added for product UI only */
  --tl-ok: #127a3a;
  --tl-no: #c4231b;
}
```
