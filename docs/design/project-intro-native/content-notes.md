# 资料映射与公开文案

两份 PDF 的页码与取舍沿用 [首轮资料记录](../project-intro-v1/content-notes.md)。本次从三份用户提供的本机资料提炼；没有另行核实设备注册、第三方技术授权或医学效果，因此不将源文件中的这些陈述包装成已核实事实。

| 项目 | 来源 | 采用内容 |
| --- | --- | --- |
| 魔法柔肤 | `13D柔肤仪.pdf`，17 页 | 13D 名称、清促建思路、肤质／肤色／日常维护关注点 |
| 露思康辰 | `露思康辰～E脉通.pdf`，37 页 | E 脉通、电磁热组成、六个体验细节、须知中的禁用提醒 |
| 海洋之蕴 | `Copy of 海洋之蕴.pptx`，17 页 | 第 1／8 页的 15D 精雕仪名称；第 7—10 页分层理念及 MFU、RF、DP 名称；第 5／15—16 页关于个体方案与持续护理的主题 |

海洋之蕴未采用：第 2 页人物履历和专利宣传，第 4／6 页未经核实的年龄／组织老化推断，第 8—12 页的国际厂商合作、FDA／CFDA／CE、专利、安全保证、组织深度及具体操作参数，第 14 页效果比例与治疗承诺，第 15 页固定疗程频次，以及第 16 页将疼痛／肿胀直接归为正常或宣称其等于胶原新生的表述。具体设备适用范围和禁忌保留在可展开须知中，不替代实际说明书。

用户指出大块“先了解，再体验”严重打断浏览体验后，三个项目统一改为底部“体验须知”折叠行。正文保留项目要点，资料溯源与审阅说明放到本文件；必要禁忌与不适处理仍在用户可打开的须知中。用户随后要求删除类似“本页为概念介绍／图示不代表效果”的字句，已从三个项目正文、图解与折叠内容中统一清除；这不新增疗效或安全保证。

## 原创图片

- `miniprogram-app/miniprogram/pages/project-intro/assets/skin-hero.jpg`：首轮原创香槟玻璃分层与水滴，生成提示词见 [首轮提示词](../project-intro-v1/art-prompts.json)。
- `miniprogram-app/miniprogram/pages/project-intro/assets/warmth-hero.jpg`：首轮原创金色波形概念雕塑，同上。
- `miniprogram-app/miniprogram/pages/project-intro/assets/ocean-hero.jpg`：本轮内置 imagegen 原创，最终提示词如下。

> Use case: stylized-concept. Create one original luxury beauty brand editorial hero artwork for Lusizhuoer 'Ocean Wonder / 海洋之蕴', representing layered facial care concept, NOT an actual device, anatomical diagram or clinical result. A sculptural upright oval made of three nested gently undulating translucent champagne glass contour ribbons, with an elegant small pearl suspended inside. Soft ivory seamless studio backdrop #fffaf3, subtle warm golden reflections #a98243 and #e6d1ad, delicate clear edges, rich glass refraction, restrained fine beauty campaign aesthetic. The sculpture is centered in the middle lower half, broad generous clean empty ivory space above, fully visible silhouette, soft grounded shadows, no people, no literal face, no skin, no medical equipment, no text, no letters, no logo, no watermarks, no blue or green, no sparkles. Premium photoreal 3D studio render, calm and precise, square composition 1024x1024.

原始图保留在本机生成目录；用于代码的 JPEG 已独立保存到小程序分包内。源图实际像素由工具决定，最终三张 JPEG 宽 1050 像素，不能将生成请求尺寸当作实际原图尺寸。
