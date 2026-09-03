"use strict";

const CANVAS_WIDTH = 1240;
const PDF_PAGE_HEIGHT = 1754;
const PAGE_MARGIN = 64;
const CONTENT_WIDTH = CANVAS_WIDTH - PAGE_MARGIN * 2;
const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_POINTS_HEIGHT = 841.89;
const OUTPUT_SCALE = 2;
const OUTPUT_WIDTH = CANVAS_WIDTH * OUTPUT_SCALE;
const OUTPUT_PAGE_HEIGHT = PDF_PAGE_HEIGHT * OUTPUT_SCALE;
const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif';
const RECEIPT_BACKGROUND_SOURCE = "/images/receipt/lusizhuoer-receipt-bg-v1.jpg";
const RECEIPT_COLORS = Object.freeze({
  background: "#fffaf3",
  panel: "rgba(255, 252, 246, 0.94)",
  panelSoft: "rgba(248, 239, 224, 0.94)",
  border: "#dfcfb4",
  title: "#302a22",
  secondary: "#7d6f5d",
  accent: "#80622f",
  accentSoft: "#f4e7d0"
});
const RECEIPT_FONT_SIZES = Object.freeze({
  kind: 28,
  title: 46,
  subtitle: 28,
  factLabel: 30,
  factValue: 48,
  sectionTitle: 38,
  sectionSubtitle: 28,
  giftName: 38,
  giftCount: 42,
  photoLabel: 34,
  photoMeta: 28,
  instructionLabel: 34,
  instructionBody: 34,
  pageNumber: 24
});

function text(value, fallback = "—") {
  const normalized = String(value === undefined || value === null ? "" : value).trim();
  return normalized || fallback;
}

function safeFilename(value) {
  return text(value, "工单")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/[. ]+$/g, "")
    .slice(0, 120) || "工单";
}

function createProductSampleDocument(options = {}) {
  const template = options.template || {};
  const kind = String(options.kind || "verification-pdf");
  const verification = kind.startsWith("verification");
  const productName = text(template.productName, "示例产品");
  const instructions = String((verification ? options.verificationInstructions : options.rechargeInstructions) || "").trim();
  const facts = [
    { label: "客户", value: "示例客户 · C1-SAMPLE001", singleLine: true },
    { label: "项目", value: productName, singleLine: true },
    { label: "门店", value: "示例门店", singleLine: true },
    { label: "业务老师", value: "示例老师", singleLine: true }
  ];
  return {
    filename: `${productName}-${verification ? "核销单" : "充值单"}-样例`,
    kind: verification ? "正常核销 / 体验核销" : "充值 / 退费",
    title: `${verification ? "核销单" : "充值单"} SAMPLE001`,
    subtitle: "门店详细地址：示例省示例市示例区示例路 1 号",
    facts,
    compactVerification: verification,
    customerFacing: true,
    detailTitle: verification ? "核销信息" : "充值信息",
    detailSubtitle: verification ? "核销次数与办理时间" : "充值次数与办理时间",
    details: verification ? [
      { label: "工单类型", value: "正常核销" },
      { label: "次数", value: "2 次" },
      { label: "提交时间", value: "2026-08-19 12:34:56", span: 2 }
    ] : [
      { label: "充值次数", value: "10 次" },
      { label: "提交时间", value: "2026-08-19 12:34:56" },
      { label: "审核时间", value: "2026-08-19 12:36:10" }
    ],
    productTemplate: {
      productName,
      productType: text(template.productType, "产品类别"),
      instructions,
      logoRequired: options.logoRequired === true
    }
  };
}

function createProductSamplePhotos(kind) {
  return [];
}

function setFont(context, size, weight = 400) {
  context.font = `${weight} ${size}px ${FONT_FAMILY}`;
}

function roundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.arcTo(x + width, y, x + width, y + height, safeRadius);
  context.arcTo(x + width, y + height, x, y + height, safeRadius);
  context.arcTo(x, y + height, x, y, safeRadius);
  context.arcTo(x, y, x + width, y, safeRadius);
  context.closePath();
}

function wrapLines(context, value, maxWidth) {
  const paragraphs = String(value === undefined || value === null ? "" : value).replace(/\r/g, "").split("\n");
  const lines = [];
  paragraphs.forEach((paragraph) => {
    if (!paragraph) { lines.push(""); return; }
    let line = "";
    Array.from(paragraph).forEach((character) => {
      const candidate = line + character;
      if (line && context.measureText(candidate).width > maxWidth) {
        lines.push(line);
        line = character;
      } else {
        line = candidate;
      }
    });
    lines.push(line);
  });
  return lines.length ? lines : [""];
}

function drawWrappedText(context, value, x, y, maxWidth, options = {}) {
  const size = options.size || 26;
  const lineHeight = options.lineHeight || Math.round(size * 1.55);
  setFont(context, size, options.weight || 400);
  const lines = wrapLines(context, value, maxWidth);
  if (options.draw !== false) {
    context.fillStyle = options.color || "#172033";
    context.textBaseline = "top";
    lines.forEach((line, index) => context.fillText(line, x, y + index * lineHeight));
  }
  return { lines, height: Math.max(lineHeight, lines.length * lineHeight) };
}

function pageBottom(y) {
  return (Math.floor(y / PDF_PAGE_HEIGHT) + 1) * PDF_PAGE_HEIGHT - PAGE_MARGIN;
}

function ensureSpace(y, required, paginate) {
  if (!paginate || y + required <= pageBottom(y)) return y;
  return (Math.floor(y / PDF_PAGE_HEIGHT) + 1) * PDF_PAGE_HEIGHT + PAGE_MARGIN;
}

function drawLabelValueCard(context, item, x, y, width, draw) {
  setFont(context, RECEIPT_FONT_SIZES.factValue, 500);
  const singleLine = item && item.singleLine === true;
  const value = singleLine ? text(item.value).replace(/\s+/g, " ") : text(item.value);
  const valueLines = singleLine ? [value] : wrapLines(context, value, width - 32);
  const valueLineHeight = 62;
  const height = Math.max(154, 74 + valueLines.length * valueLineHeight);
  if (draw) {
    context.fillStyle = RECEIPT_COLORS.panel;
    context.strokeStyle = RECEIPT_COLORS.border;
    context.lineWidth = 1;
    roundedRect(context, x, y, width, height, 12);
    context.fill();
    context.stroke();
    context.fillStyle = RECEIPT_COLORS.secondary;
    setFont(context, RECEIPT_FONT_SIZES.factLabel, 600);
    context.textBaseline = "top";
    context.fillText(text(item.label), x + 18, y + 17);
    if (singleLine) {
      const maxWidth = width - 36;
      const normalSize = RECEIPT_FONT_SIZES.factValue;
      setFont(context, normalSize, 750);
      const measured = Math.max(1, context.measureText(value).width);
      const fittedSize = Math.max(34, Math.min(normalSize, Math.floor(normalSize * maxWidth / measured)));
      context.save();
      roundedRect(context, x + 16, y + 53, maxWidth + 4, 78, 0);
      context.clip();
      context.fillStyle = RECEIPT_COLORS.title;
      setFont(context, fittedSize, 750);
      context.textBaseline = "top";
      context.fillText(value, x + 18, y + 61, maxWidth);
      context.restore();
    } else {
      drawWrappedText(context, value, x + 18, y + 61, width - 36, {
        draw: true, size: RECEIPT_FONT_SIZES.factValue, lineHeight: valueLineHeight, weight: 750, color: RECEIPT_COLORS.title
      });
    }
  }
  return height;
}

function drawSectionHeading(context, title, subtitle, y, draw) {
  if (draw) {
    context.fillStyle = RECEIPT_COLORS.title;
    setFont(context, RECEIPT_FONT_SIZES.sectionTitle, 850);
    context.textBaseline = "top";
    context.fillText(text(title), PAGE_MARGIN, y);
    if (subtitle) {
      context.fillStyle = RECEIPT_COLORS.secondary;
      setFont(context, RECEIPT_FONT_SIZES.sectionSubtitle, 450);
      context.fillText(String(subtitle), PAGE_MARGIN, y + 57);
    }
  }
  return y + (subtitle ? 106 : 76);
}

function drawImageContain(context, image, x, y, width, height) {
  const imageWidth = Number(image && (image.width || image.naturalWidth) || 0);
  const imageHeight = Number(image && (image.height || image.naturalHeight) || 0);
  if (!imageWidth || !imageHeight) return;
  const scale = Math.min(width / imageWidth, height / imageHeight);
  const drawWidth = imageWidth * scale;
  const drawHeight = imageHeight * scale;
  context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
}

function drawDocumentHeader(context, documentData, productLogo, draw) {
  const top = 44;
  const gap = 28;
  const logoSize = 132;
  const leftWidth = CONTENT_WIDTH - logoSize - gap;
  const kind = text(documentData.kind, documentData.detailTitle || "业务工单");
  const title = text(documentData.title, "业务工单");
  const subtitle = text(documentData.subtitle, "业务工单完整导出");
  setFont(context, RECEIPT_FONT_SIZES.kind, 800);
  const kindWidth = Math.min(leftWidth, Math.max(112, context.measureText(kind).width + 42));
  const titleY = top + 61;
  const titleMetrics = drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
    draw: false, size: RECEIPT_FONT_SIZES.title, lineHeight: 60, weight: 900
  });
  const subtitleY = titleY + titleMetrics.height + 10;
  const subtitleMetrics = drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
    draw: false, size: RECEIPT_FONT_SIZES.subtitle, lineHeight: 42
  });
  const logoX = PAGE_MARGIN + leftWidth + gap;
  const bottom = Math.max(subtitleY + subtitleMetrics.height, top + logoSize) + 30;
  if (!draw) return bottom;

  context.fillStyle = RECEIPT_COLORS.accent;
  context.fillRect(0, 0, CANVAS_WIDTH, 18);
  context.fillStyle = RECEIPT_COLORS.accentSoft;
  roundedRect(context, PAGE_MARGIN, top, kindWidth, 46, 23);
  context.fill();
  context.fillStyle = RECEIPT_COLORS.accent;
  setFont(context, RECEIPT_FONT_SIZES.kind, 800);
  context.textBaseline = "middle";
  context.fillText(kind, PAGE_MARGIN + 21, top + 23);

  drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
    draw: true, size: RECEIPT_FONT_SIZES.title, lineHeight: 60, weight: 900, color: RECEIPT_COLORS.title
  });
  drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
    draw: true, size: RECEIPT_FONT_SIZES.subtitle, lineHeight: 42, color: RECEIPT_COLORS.secondary
  });

  context.fillStyle = RECEIPT_COLORS.panel;
  context.strokeStyle = RECEIPT_COLORS.border;
  context.lineWidth = 1;
  roundedRect(context, logoX, top, logoSize, logoSize, 16);
  context.fill();
  context.stroke();
  context.save();
  roundedRect(context, logoX + 8, top + 8, logoSize - 16, logoSize - 16, 12);
  context.clip();
  if (productLogo && productLogo.image) {
    drawImageContain(context, productLogo.image, logoX + 8, top + 8, logoSize - 16, logoSize - 16);
  } else {
    context.fillStyle = RECEIPT_COLORS.panelSoft;
    context.fillRect(logoX + 8, top + 8, logoSize - 16, logoSize - 16);
    context.fillStyle = RECEIPT_COLORS.accent;
    setFont(context, 22, 900);
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText("LOGO", logoX + logoSize / 2, top + logoSize / 2);
  }
  context.restore();
  context.textAlign = "left";
  context.textBaseline = "top";
  return bottom;
}

function drawInfoGrid(context, items, y, draw, paginate, columns = 2) {
  const gap = 14;
  const columnCount = Math.max(1, Math.min(3, Number(columns) || 2));
  const regularWidth = (CONTENT_WIDTH - gap * (columnCount - 1)) / columnCount;
  for (let index = 0; index < items.length;) {
    const firstItem = items[index];
    const requestedSpan = /时间$/.test(text(firstItem && firstItem.label, ""))
      ? columnCount
      : Math.max(1, Math.min(columnCount, Number(firstItem && firstItem.span || 1)));
    if (requestedSpan === columnCount) {
      const item = items[index];
      const rowHeight = drawLabelValueCard(context, item, PAGE_MARGIN, y, CONTENT_WIDTH, false);
      y = ensureSpace(y, rowHeight + 14, paginate);
      drawLabelValueCard(context, item, PAGE_MARGIN, y, CONTENT_WIDTH, draw);
      y += rowHeight + 14;
      index += 1;
      continue;
    }
    const row = [];
    while (index < items.length && row.length < columnCount) {
      const item = items[index];
      if (/时间$/.test(text(item && item.label, "")) || Number(item && item.span || 1) >= columnCount) break;
      row.push(item);
      index += 1;
    }
    if (!row.length) continue;
    const width = row.length === 1 ? CONTENT_WIDTH : regularWidth;
    const rowHeight = Math.max(...row.map((item) => drawLabelValueCard(context, item, PAGE_MARGIN, y, width, false)));
    y = ensureSpace(y, rowHeight + 14, paginate);
    row.forEach((item, column) => drawLabelValueCard(context, item, PAGE_MARGIN + column * (width + gap), y, width, draw));
    y += rowHeight + 14;
  }
  return y;
}

function drawProductGiftCard(context, item, index, y, draw, paginate) {
  const height = 122;
  y = ensureSpace(y, height + 14, paginate);
  if (draw) {
    context.fillStyle = RECEIPT_COLORS.panel;
    context.strokeStyle = RECEIPT_COLORS.border;
    context.lineWidth = 1;
    roundedRect(context, PAGE_MARGIN, y, CONTENT_WIDTH, height, 12);
    context.fill();
    context.stroke();

    const quantityWidth = 150;
    const textWidth = CONTENT_WIDTH - quantityWidth - 54;
    context.fillStyle = RECEIPT_COLORS.title;
    setFont(context, RECEIPT_FONT_SIZES.giftName, 800);
    context.textBaseline = "middle";
    context.fillText(text(item.productName, `赠予产品 ${index + 1}`), PAGE_MARGIN + 18, y + height / 2, textWidth);
    context.fillStyle = RECEIPT_COLORS.accent;
    setFont(context, RECEIPT_FONT_SIZES.giftCount, 900);
    context.textAlign = "right";
    context.textBaseline = "middle";
    context.fillText(`${Math.max(0, Number(item.unitCount) || 0)} 件`, PAGE_MARGIN + CONTENT_WIDTH - 20, y + height / 2);
    context.textAlign = "left";
    context.textBaseline = "top";
  }
  return y + height + 14;
}

function drawProductGifts(context, productGifts, y, draw, paginate) {
  const gifts = Array.isArray(productGifts) ? productGifts : [];
  if (!gifts.length) return y;
  y += 16;
  y = ensureSpace(y, 70 + 100, paginate);
  y = drawSectionHeading(context, "赠予产品", "本次充值随单赠予的产品名称与数量", y, draw);
  gifts.forEach((gift, index) => { y = drawProductGiftCard(context, gift, index, y, draw, paginate); });
  return y;
}

function drawInstructionChunk(context, lines, label, y, draw) {
  const padding = 24;
  const lineHeight = 52;
  const height = Math.max(166, 92 + lines.length * lineHeight);
  if (draw) {
    context.fillStyle = RECEIPT_COLORS.panel;
    context.strokeStyle = RECEIPT_COLORS.border;
    roundedRect(context, PAGE_MARGIN, y, CONTENT_WIDTH, height, 12);
    context.fill();
    context.stroke();
    context.fillStyle = RECEIPT_COLORS.title;
    setFont(context, RECEIPT_FONT_SIZES.instructionLabel, 850);
    context.textBaseline = "top";
    context.fillText(label, PAGE_MARGIN + padding, y + 18);
    context.fillStyle = RECEIPT_COLORS.title;
    setFont(context, RECEIPT_FONT_SIZES.instructionBody, 450);
    lines.forEach((line, index) => context.fillText(line, PAGE_MARGIN + padding, y + 72 + index * lineHeight));
  }
  return y + height + 14;
}

function drawInstructionText(context, value, y, draw, paginate) {
  const padding = 24;
  const lineHeight = 52;
  setFont(context, RECEIPT_FONT_SIZES.instructionBody, 450);
  const lines = wrapLines(context, text(value, "无"), CONTENT_WIDTH - padding * 2);
  if (!paginate) return drawInstructionChunk(context, lines, "说明", y, draw);
  let offset = 0;
  let part = 0;
  while (offset < lines.length) {
    y = ensureSpace(y, 146, true);
    const availableHeight = Math.max(166, pageBottom(y) - y - 14);
    const maxLines = Math.max(1, Math.floor((availableHeight - 92) / lineHeight));
    const chunk = lines.slice(offset, offset + maxLines);
    y = drawInstructionChunk(context, chunk, part === 0 ? "说明" : "说明（续）", y, draw);
    offset += chunk.length;
    part += 1;
  }
  return y;
}

function drawPhotoCard(context, photo, x, y, width, draw, options = {}) {
  const imageHeight = options.imageHeight || 330;
  const cardHeight = options.cardHeight || 420;
  if (draw) {
    context.fillStyle = RECEIPT_COLORS.panel;
    context.strokeStyle = RECEIPT_COLORS.border;
    roundedRect(context, x, y, width, cardHeight, 14);
    context.fill();
    context.stroke();
    context.save();
    roundedRect(context, x + 12, y + 12, width - 24, imageHeight, 10);
    context.clip();
    context.fillStyle = RECEIPT_COLORS.panelSoft;
    context.fillRect(x + 12, y + 12, width - 24, imageHeight);
    if (photo.image) {
      drawImageContain(context, photo.image, x + 12, y + 12, width - 24, imageHeight);
    } else {
      context.fillStyle = RECEIPT_COLORS.secondary;
      setFont(context, 23, 650);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text(photo.placeholder, "尚未上传"), x + width / 2, y + 12 + imageHeight / 2);
      context.textAlign = "left";
      context.textBaseline = "top";
    }
    context.restore();
    context.fillStyle = RECEIPT_COLORS.title;
    setFont(context, RECEIPT_FONT_SIZES.photoLabel, 850);
    context.textBaseline = "top";
    context.fillText(text(photo.label), x + 18, y + imageHeight + 26);
    context.fillStyle = RECEIPT_COLORS.secondary;
    setFont(context, RECEIPT_FONT_SIZES.photoMeta, 450);
    context.fillText(text(photo.meta, photo.image ? "已载入原图" : "空照片位"), x + 18, y + imageHeight + 58);
  }
  return cardHeight;
}

function drawPhotos(context, photos, y, draw, paginate) {
  const gap = 16;
  const width = (CONTENT_WIDTH - gap) / 2;
  for (let index = 0; index < photos.length; index += 2) {
    y = ensureSpace(y, 434, paginate);
    drawPhotoCard(context, photos[index], PAGE_MARGIN, y, width, draw);
    if (photos[index + 1]) drawPhotoCard(context, photos[index + 1], PAGE_MARGIN + width + gap, y, width, draw);
    y += 434;
  }
  return y;
}

function drawProductInstructions(context, documentData, y, draw, paginate) {
  const template = documentData.productTemplate || {};
  const instructions = String(template.instructions || "").trim();
  if (!instructions) return y;
  y += 10;
  y = ensureSpace(y, 86, paginate);
  y = drawSectionHeading(context, "产品说明", "", y, draw);
  return drawInstructionText(context, instructions, y, draw, paginate);
}

function drawRatingQr(context, documentData, ratingQr, y, draw, paginate) {
  if (!ratingQr?.enabled) return y;
  y += 16;
  y = ensureSpace(y, 350, paginate);
  y = drawSectionHeading(context, "客户评价", "本二维码仅与当前核销工单绑定", y, draw);
  const height = 310;
  if (draw) {
    if (!ratingQr.image) throw new Error("客户评价二维码尚未完整载入，本次没有生成文件。");
    context.fillStyle = RECEIPT_COLORS.panel;
    context.strokeStyle = RECEIPT_COLORS.border;
    context.lineWidth = 1;
    roundedRect(context, PAGE_MARGIN, y, CONTENT_WIDTH, height, 14);
    context.fill();
    context.stroke();
    const qrSize = 220;
    const qrX = PAGE_MARGIN + 20;
    const qrY = y + 20;
    context.fillStyle = "#ffffff";
    roundedRect(context, qrX, qrY, qrSize, qrSize, 10);
    context.fill();
    drawImageContain(context, ratingQr.image, qrX, qrY, qrSize, qrSize);
    const textX = qrX + qrSize + 34;
    const textWidth = CONTENT_WIDTH - qrSize - 74;
    context.fillStyle = RECEIPT_COLORS.title;
    setFont(context, 40, 850);
    context.textBaseline = "top";
    context.fillText(text(documentData.ratingQr?.title, "扫码评价本次服务"), textX, y + 50, textWidth);
    drawWrappedText(context, text(documentData.ratingQr?.description, "选择 1–5 星并留下您的意见。"), textX, y + 102, textWidth, {
      draw: true, size: 32, lineHeight: 48, color: RECEIPT_COLORS.secondary
    });
    context.fillStyle = RECEIPT_COLORS.accent;
    setFont(context, 28, 750);
    context.fillText("请使用微信扫码 · 每张工单仅可评价一次", textX, y + 250, textWidth);
  }
  return y + height + 14;
}

function drawReceiptBackground(context, backgroundImage, documentHeight) {
  const height = Math.max(0, Number(documentHeight || 0));
  context.fillStyle = RECEIPT_COLORS.background;
  context.fillRect(0, 0, CANVAS_WIDTH, height);
  if (!backgroundImage || !height) return;
  const pageCount = Math.max(1, Math.ceil(height / PDF_PAGE_HEIGHT));
  for (let page = 0; page < pageCount; page += 1) {
    context.drawImage(backgroundImage, 0, page * PDF_PAGE_HEIGHT, CANVAS_WIDTH, PDF_PAGE_HEIGHT);
  }
}

function printableReceiptPhotos(documentData, photoItems) {
  const photos = Array.isArray(photoItems) ? photoItems : [];
  if (documentData.compactVerification === true) return [];
  return photos;
}

function layoutDocument(context, documentData, photos, productLogo, ratingQr, options = {}) {
  const draw = options.draw === true;
  const paginate = options.paginate === true;
  const compactVerification = documentData.compactVerification === true;
  if (draw) {
    drawReceiptBackground(context, options.backgroundImage || null, options.documentHeight);
  }
  let y = drawDocumentHeader(context, documentData, productLogo, draw);
  y = drawInfoGrid(context, documentData.facts || [], y, draw, paginate);
  y += 12;
  y = ensureSpace(y, 70, paginate);
  y = drawSectionHeading(context, documentData.detailTitle || "工单信息", documentData.detailSubtitle, y, draw);
  const details = documentData.details || [];
  y = drawInfoGrid(context, details, y, draw, paginate, 2);
  y = drawProductGifts(context, documentData.productGifts, y, draw, paginate);

  if (!compactVerification && photos.length) {
    y += 16;
    y = ensureSpace(y, 86, paginate);
    y = drawSectionHeading(context, "客户核销照片", "仅保留核销时使用的身份照片", y, draw);
    y = drawPhotos(context, photos, y, draw, paginate);
  }

  y = drawProductInstructions(context, documentData, y, draw, paginate);
  y = drawRatingQr(context, documentData, ratingQr, y, draw, paginate);
  return y + 24;
}

function loadCanvasImage(canvas, source, errorMessage) {
  return new Promise((resolve, reject) => {
    const image = canvas.createImage();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(errorMessage));
    image.src = source;
  });
}

async function prepareProductLogo(canvas, documentData, logoSource) {
  const template = documentData.productTemplate || {};
  if (!logoSource) {
    if (template.logoRequired === true) throw new Error("产品 LOGO 原图尚未完整载入，本次没有生成文件。请重试。");
    return { image: null };
  }
  try {
    return { image: await loadCanvasImage(canvas, logoSource, "产品 LOGO 原图解码失败，本次没有生成文件。请重试。") };
  } catch (error) {
    if (template.logoRequired === true) throw error;
    return { image: null };
  }
}

async function prepareRatingQr(canvas, documentData) {
  const source = String(documentData?.ratingQr?.source || "").trim();
  if (!source) return { enabled: false, image: null };
  if (!/^data:image\/png;base64,[A-Za-z0-9+/=]+$/i.test(source)) {
    throw new Error("客户评价二维码格式无效，本次没有生成文件。");
  }
  return {
    enabled: true,
    image: await loadCanvasImage(canvas, source, "客户评价二维码解码失败，本次没有生成文件。请重试。")
  };
}

async function preparePhotos(canvas, photoItems) {
  const prepared = [];
  for (const item of photoItems || []) {
    const source = item.source || item.path || item.url || "";
    let image = null;
    if (source) {
      try { image = await loadCanvasImage(canvas, source, `${text(item.label, "核销照片")}解码失败，本次没有生成文件。请重试。`); }
      catch (error) { if (item.required) throw error; }
    }
    if (item.required && !image) throw new Error(`${text(item.label, "核销照片")}尚未完整载入，本次没有生成文件。请重试。`);
    prepared.push({ ...item, image });
  }
  const requiredCount = prepared.filter((item) => item.required).length;
  const embeddedCount = prepared.filter((item) => item.required && item.image).length;
  if (embeddedCount !== requiredCount) throw new Error("核销照片完整性检查未通过，本次没有生成文件。请重试。");
  return prepared;
}

async function prepareReceiptBackground(canvas, source) {
  if (!source) throw new Error("露思卓儿凭证背景尚未配置，本次没有生成文件。");
  return loadCanvasImage(canvas, source, "露思卓儿凭证背景载入失败，本次没有生成文件。请重试。");
}

function drawPreparedReceipt(canvas, prepared, pageIndex = null) {
  const paged = Number.isInteger(pageIndex);
  const logicalHeight = paged ? PDF_PAGE_HEIGHT : prepared.height;
  canvas.width = OUTPUT_WIDTH;
  canvas.height = Math.ceil(logicalHeight * OUTPUT_SCALE);
  const context = canvas.getContext("2d");
  context.scale(OUTPUT_SCALE, OUTPUT_SCALE);
  if (paged) {
    context.save();
    context.translate(0, -pageIndex * PDF_PAGE_HEIGHT);
  }
  layoutDocument(context, prepared.documentData, prepared.photos, prepared.productLogo, prepared.ratingQr, {
    draw: true,
    paginate: prepared.paginate,
    backgroundImage: prepared.backgroundImage,
    documentHeight: prepared.height
  });
  if (prepared.paginate) {
    for (let page = 0; page < prepared.pageCount; page += 1) {
      context.fillStyle = RECEIPT_COLORS.secondary;
      setFont(context, RECEIPT_FONT_SIZES.pageNumber, 550);
      context.textAlign = "center";
      context.textBaseline = "bottom";
      context.fillText(`第 ${page + 1} / ${prepared.pageCount} 页`, CANVAS_WIDTH / 2, (page + 1) * PDF_PAGE_HEIGHT - 20);
    }
    context.textAlign = "left";
    context.textBaseline = "top";
  }
  if (paged) context.restore();
}

async function renderReceiptCanvas(options = {}) {
  const canvas = options.canvas;
  if (!canvas || typeof canvas.getContext !== "function") throw new Error("单据画布尚未准备完成");
  const documentData = options.documentData || {};
  const rawPhotos = printableReceiptPhotos(documentData, options.photos || []);
  const paginate = options.paginate === true;
  canvas.width = CANVAS_WIDTH;
  canvas.height = 500;
  let context = canvas.getContext("2d");
  const measureRatingQr = { enabled: Boolean(documentData?.ratingQr?.source), image: null };
  const usedHeight = layoutDocument(context, documentData, rawPhotos, { image: null }, measureRatingQr, { draw: false, paginate });
  const height = paginate
    ? Math.max(PDF_PAGE_HEIGHT, Math.ceil(usedHeight / PDF_PAGE_HEIGHT) * PDF_PAGE_HEIGHT)
    : Math.max(500, Math.ceil(usedHeight));
  const [backgroundImage, productLogo, photos, ratingQr] = await Promise.all([
    prepareReceiptBackground(canvas, options.backgroundSource || RECEIPT_BACKGROUND_SOURCE),
    prepareProductLogo(canvas, documentData, options.logoSource || ""),
    preparePhotos(canvas, rawPhotos),
    prepareRatingQr(canvas, documentData)
  ]);
  const pageCount = paginate ? Math.ceil(height / PDF_PAGE_HEIGHT) : 1;
  const prepared = { documentData, photos, productLogo, ratingQr, backgroundImage, height, pageCount, paginate };
  const renderPage = paginate
    ? (pageIndex) => {
      const index = Number(pageIndex);
      if (!Number.isInteger(index) || index < 0 || index >= pageCount) throw new Error("PDF 页码超出范围");
      drawPreparedReceipt(canvas, prepared, index);
    }
    : null;
  if (renderPage) renderPage(0); else drawPreparedReceipt(canvas, prepared);
  return {
    canvas,
    width: OUTPUT_WIDTH,
    height: paginate ? OUTPUT_PAGE_HEIGHT : Math.ceil(height * OUTPUT_SCALE),
    logicalWidth: CANVAS_WIDTH,
    logicalHeight: height,
    pageHeight: OUTPUT_PAGE_HEIGHT,
    pixelScale: OUTPUT_SCALE,
    pageCount,
    paginate,
    renderPage
  };
}

function canvasToTempFile(scope, options) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({ ...options, success: resolve, fail: reject }, scope);
  });
}

async function exportReceiptJpegs(receipt, scope) {
  const pages = [];
  const count = receipt.paginate ? receipt.pageCount : 1;
  const width = Number(receipt.width || CANVAS_WIDTH);
  const height = receipt.paginate ? Number(receipt.pageHeight || PDF_PAGE_HEIGHT) : Number(receipt.height || PDF_PAGE_HEIGHT);
  for (let index = 0; index < count; index += 1) {
    if (receipt.paginate && typeof receipt.renderPage === "function") receipt.renderPage(index);
    const sequentialPage = receipt.paginate && typeof receipt.renderPage === "function";
    const output = await canvasToTempFile(scope, {
      canvas: receipt.canvas,
      x: 0,
      y: receipt.paginate && !sequentialPage ? index * height : 0,
      width,
      height,
      destWidth: width,
      destHeight: height,
      fileType: "jpg",
      quality: receipt.paginate ? 0.98 : 0.97
    });
    if (!output || !output.tempFilePath) throw new Error(receipt.paginate ? `PDF 第 ${index + 1} 页生成失败` : "导出图片生成失败");
    pages.push({ path: output.tempFilePath, width, height, pageNumber: index + 1 });
  }
  return pages;
}

function ascii(value) {
  const output = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) output[index] = value.charCodeAt(index) & 255;
  return output;
}

function concatBytes(chunks) {
  const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
  return output;
}

function createPdfBytes(jpegPages) {
  if (!Array.isArray(jpegPages) || !jpegPages.length) throw new Error("没有可写入 PDF 的页面");
  const pages = jpegPages.map((page) => ({
    width: Number(page.width || OUTPUT_WIDTH),
    height: Number(page.height || OUTPUT_PAGE_HEIGHT),
    bytes: page.bytes instanceof Uint8Array ? page.bytes : new Uint8Array(page.bytes)
  }));
  pages.forEach((page, index) => {
    if (!page.width || !page.height || page.bytes.byteLength < 4
        || page.bytes[0] !== 0xff || page.bytes[1] !== 0xd8 || page.bytes[2] !== 0xff) {
      throw new Error(`PDF 第 ${index + 1} 页不是有效 JPEG`);
    }
  });
  const pageObjectNumbers = pages.map((_, index) => 3 + index * 3);
  const objectCount = 2 + pages.length * 3;
  const objects = new Map();
  objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.set(2, ascii(`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${pages.length} >>`));
  pages.forEach((page, index) => {
    const pageNumber = 3 + index * 3;
    const imageNumber = pageNumber + 1;
    const contentNumber = pageNumber + 2;
    const imageName = `Im${index + 1}`;
    objects.set(pageNumber, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PDF_PAGE_WIDTH} ${PDF_PAGE_POINTS_HEIGHT}] /Resources << /XObject << /${imageName} ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`));
    objects.set(imageNumber, concatBytes([
      ascii(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`),
      page.bytes,
      ascii("\nendstream")
    ]));
    const command = `q\n${PDF_PAGE_WIDTH} 0 0 ${PDF_PAGE_POINTS_HEIGHT} 0 0 cm\n/${imageName} Do\nQ\n`;
    objects.set(contentNumber, ascii(`<< /Length ${ascii(command).length} >>\nstream\n${command}endstream`));
  });

  const chunks = [concatBytes([ascii("%PDF-1.4\n%"), new Uint8Array([0xe2, 0xe3, 0xcf, 0xd3]), ascii("\n")])];
  const offsets = new Array(objectCount + 1).fill(0);
  let length = chunks[0].length;
  for (let number = 1; number <= objectCount; number += 1) {
    const chunk = concatBytes([ascii(`${number} 0 obj\n`), objects.get(number), ascii("\nendobj\n")]);
    offsets[number] = length;
    chunks.push(chunk);
    length += chunk.length;
  }
  const xrefOffset = length;
  chunks.push(ascii([
    `xref\n0 ${objectCount + 1}\n`,
    "0000000000 65535 f \n",
    ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
  ].join("")));
  return concatBytes(chunks).buffer;
}

module.exports = {
  CANVAS_WIDTH,
  PDF_PAGE_HEIGHT,
  PDF_PAGE_WIDTH,
  PDF_PAGE_POINTS_HEIGHT,
  OUTPUT_SCALE,
  OUTPUT_WIDTH,
  OUTPUT_PAGE_HEIGHT,
  RECEIPT_BACKGROUND_SOURCE,
  createProductSampleDocument,
  createProductSamplePhotos,
  renderReceiptCanvas,
  exportReceiptJpegs,
  createPdfBytes,
  safeFilename
};
