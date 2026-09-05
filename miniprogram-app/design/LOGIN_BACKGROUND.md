# 小程序登录背景 v4

2026-09-05 按用户要求保留象牙白／香槟金／深咖配色，精修原 v3 背景中显得模糊的纹理与边缘。本次使用内置 `image_gen` 编辑模式，以 v3 为唯一图像参考；保留可辨认的水滴／侧脸标志，不生成文字。

- 源文件：`miniprogram/images/login/lusizhuoer-login-bg-v3.jpg`。
- 接入文件：`miniprogram/images/login/lusizhuoer-login-bg-v4.jpg`。
- 实际生成尺寸：852 × 1846 像素。提示词中的 1536 × 3328 未被生成器采用，没有放大后冒充更高分辨率。
- 接入仅使用 macOS `sips` 转为质量 92 的 JPEG，保留实际尺寸；184,017 字节，比旧图 197,751 字节略小。
- 视觉调整：减少细碎金丝和毛糙高光，采用少量平顺金色曲线，增强浮雕边缘，保留中心留白。
- 背景和登录品牌视窗复用同一文件；WXML 原生渲染“露思卓儿”，WXSS 的原配色值保持不变。动画结束恢复无变换状态。
- 此图是位图背景，清晰度优化来自纹理与轮廓设计，不代表无限放大或真矢量。

## 完整生成提示词

```text
Use case: precise-object-edit.
Asset type: production background image for the Lusizhuoer beauty brand's native WeChat mini-program login page.
Input image 1 is the edit target and the sole authoritative reference for colors and the brand's water-drop / woman's side-profile emblem.
Primary request: refine this exact background so it looks crisp and quietly premium on high-density phones and iPads, retaining its warm ivory and pale champagne-gold palette. Produce a portrait image at 1536 x 3328 pixels.
Keep: the same recognizable water-drop / side-profile brand emblem, the same overall very light warm ivory base (#f3ede2 / #fffaf3), pale champagne gold accents related to #a98243, the emblem centered horizontally in the upper fifth of the image, and an open quiet center for a separately coded login card.
Change: remove fuzzy fibrous/threadlike detail, smeared highlights and busy microscopic texture. Replace the busy edge filaments with two or three broad, smooth, sculptural satin-gold curves with precise, clean boundaries and restrained reflections, mainly along the top-left and bottom-right edges. Refine the existing embossed emblem with clearly resolved edges, a slightly more legible champagne-gold outline and narrow soft shadows; do not redesign the emblem or change the profile silhouette. The main logo bounds should remain approximately x=23%-79%, y=8%-32%, matching the reference.
Style: minimal, sophisticated skincare / beauty branding, polished material rendering, controlled light, generous negative space. Soft tonal gradients are intentional; outlines and material edges must be sharp and resolved, without pixelated or painted blur.
Constraints: edit only the background artwork, preserve the brand colors and recognizable mark, no darkening the page, no blue/green theme, no extra emblems, no people or photographic faces, no text or letters, no form controls, no phone mockup, no UI, no border, no watermark. Avoid glitter, noisy gold threads, bokeh, lens blur, halos and heavy contrast.
```
