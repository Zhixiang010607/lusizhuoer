"use strict";

const CANVAS_WIDTH = 1240;
const PDF_PAGE_HEIGHT = 1754;
const PAGE_MARGIN = 64;
const CONTENT_WIDTH = CANVAS_WIDTH - PAGE_MARGIN * 2;
const PDF_PAGE_WIDTH = 595.28;
const PDF_PAGE_POINTS_HEIGHT = 841.89;
const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif';

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
    { label: "门店", value: "示例门店" },
    { label: "客户", value: "示例客户" },
    { label: "项目", value: productName },
    { label: "业务老师", value: "示例老师" }
  ];
  if (verification) facts.push({ label: "提交时间", value: "2026-08-19 12:34:56" });
  return {
    filename: `${productName}-${verification ? "核销单" : "充值单"}-样例`,
    kind: verification ? "正常核销 / 体验核销" : "充值 / 退费",
    title: `${verification ? "核销单" : "充值单"} SAMPLE001`,
    subtitle: "门店详细地址：示例省示例市示例区示例路 1 号",
    facts,
    compactVerification: verification,
    customerFacing: true,
    detailTitle: "充值信息",
    detailSubtitle: "充值次数与办理时间",
    details: verification ? [] : [
      { label: "充值次数", value: "10 次" },
      { label: "提交时间", value: "2026-08-19 12:34:56" },
      { label: "审核时间", value: "2026-08-19 12:36:10" }
    ],
    messages: [],
    productTemplate: {
      productName,
      productType: text(template.productType, "产品类别"),
      instructions,
      logoRequired: options.logoRequired === true
    }
  };
}

function createProductSamplePhotos(kind) {
  if (!String(kind || "").startsWith("verification")) return [];
  return ["客户建档照片", "本次核销人脸照", "补充照片 1", "补充照片 2", "补充照片 3"]
    .map((label) => ({ label, required: false, placeholder: "照片区域", meta: "样例照片位" }));
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
  const size = options.size || 24;
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
  setFont(context, 19, 500);
  const valueLines = wrapLines(context, text(item.value), width - 32);
  const height = Math.max(86, 48 + valueLines.length * 29);
  if (draw) {
    context.fillStyle = "#f6f8fb";
    context.strokeStyle = "#d9e2ee";
    context.lineWidth = 1;
    roundedRect(context, x, y, width, height, 12);
    context.fill();
    context.stroke();
    context.fillStyle = "#61708a";
    setFont(context, 16, 500);
    context.textBaseline = "top";
    context.fillText(text(item.label), x + 16, y + 14);
    drawWrappedText(context, text(item.value), x + 16, y + 40, width - 32, {
      draw: true, size: 19, lineHeight: 29, weight: 700, color: "#101828"
    });
  }
  return height;
}

function drawSectionHeading(context, title, subtitle, y, draw) {
  if (draw) {
    context.fillStyle = "#10233f";
    setFont(context, 27, 800);
    context.textBaseline = "top";
    context.fillText(text(title), PAGE_MARGIN, y);
    if (subtitle) {
      context.fillStyle = "#667085";
      setFont(context, 16, 400);
      context.fillText(String(subtitle), PAGE_MARGIN, y + 39);
    }
  }
  return y + (subtitle ? 68 : 48);
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
  setFont(context, 18, 800);
  const kindWidth = Math.min(leftWidth, Math.max(96, context.measureText(kind).width + 34));
  const titleY = top + 51;
  const titleMetrics = drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
    draw: false, size: 42, lineHeight: 52, weight: 900
  });
  const subtitleY = titleY + titleMetrics.height + 8;
  const subtitleMetrics = drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
    draw: false, size: 18, lineHeight: 28
  });
  const logoX = PAGE_MARGIN + leftWidth + gap;
  const bottom = Math.max(subtitleY + subtitleMetrics.height, top + logoSize) + 30;
  if (!draw) return bottom;

  context.fillStyle = "#10233f";
  context.fillRect(0, 0, CANVAS_WIDTH, 18);
  context.fillStyle = "#edf4ff";
  roundedRect(context, PAGE_MARGIN, top, kindWidth, 34, 17);
  context.fill();
  context.fillStyle = "#245796";
  setFont(context, 18, 800);
  context.textBaseline = "middle";
  context.fillText(kind, PAGE_MARGIN + 17, top + 17);

  drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
    draw: true, size: 42, lineHeight: 52, weight: 900, color: "#10233f"
  });
  drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
    draw: true, size: 18, lineHeight: 28, color: "#667085"
  });

  context.fillStyle = "#f8fbff";
  context.strokeStyle = "#d9e2ee";
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
    context.fillStyle = "#d9e7f8";
    context.fillRect(logoX + 8, top + 8, logoSize - 16, logoSize - 16);
    context.fillStyle = "#315378";
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
  const width = (CONTENT_WIDTH - gap * (columnCount - 1)) / columnCount;
  for (let index = 0; index < items.length; index += columnCount) {
    const row = items.slice(index, index + columnCount);
    const rowHeight = Math.max(...row.map((item) => drawLabelValueCard(context, item, PAGE_MARGIN, y, width, false)));
    y = ensureSpace(y, rowHeight + 14, paginate);
    row.forEach((item, column) => drawLabelValueCard(context, item, PAGE_MARGIN + column * (width + gap), y, width, draw));
    y += rowHeight + 14;
  }
  return y;
}

function drawMessageCard(context, item, y, draw, paginate) {
  const padding = 22;
  setFont(context, 19, 400);
  const bodyLines = wrapLines(context, text(item.value, "无"), CONTENT_WIDTH - padding * 2);
  const height = Math.max(112, 66 + bodyLines.length * 31);
  y = ensureSpace(y, height + 14, paginate);
  if (draw) {
    context.fillStyle = "#fbfcfe";
    context.strokeStyle = "#d9e2ee";
    roundedRect(context, PAGE_MARGIN, y, CONTENT_WIDTH, height, 12);
    context.fill();
    context.stroke();
    context.fillStyle = "#10233f";
    setFont(context, 20, 800);
    context.textBaseline = "top";
    context.fillText(text(item.label), PAGE_MARGIN + padding, y + 17);
    if (item.time) {
      context.fillStyle = "#667085";
      setFont(context, 15, 400);
      const timeWidth = context.measureText(String(item.time)).width;
      context.fillText(String(item.time), PAGE_MARGIN + CONTENT_WIDTH - padding - timeWidth, y + 20);
    }
    drawWrappedText(context, text(item.value, "无"), PAGE_MARGIN + padding, y + 53, CONTENT_WIDTH - padding * 2, {
      draw: true, size: 19, lineHeight: 31, color: "#344054"
    });
  }
  return y + height + 14;
}

function drawPhotoCard(context, photo, x, y, width, draw, options = {}) {
  const imageHeight = options.imageHeight || 330;
  const cardHeight = options.cardHeight || 420;
  if (draw) {
    context.fillStyle = "#f6f8fb";
    context.strokeStyle = "#d9e2ee";
    roundedRect(context, x, y, width, cardHeight, 14);
    context.fill();
    context.stroke();
    context.save();
    roundedRect(context, x + 12, y + 12, width - 24, imageHeight, 10);
    context.clip();
    context.fillStyle = "#e9eef5";
    context.fillRect(x + 12, y + 12, width - 24, imageHeight);
    if (photo.image) {
      drawImageContain(context, photo.image, x + 12, y + 12, width - 24, imageHeight);
    } else {
      context.fillStyle = "#7a879b";
      setFont(context, 20, 600);
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillText(text(photo.placeholder, "尚未上传"), x + width / 2, y + 12 + imageHeight / 2);
      context.textAlign = "left";
      context.textBaseline = "top";
    }
    context.restore();
    context.fillStyle = "#10233f";
    setFont(context, 20, 800);
    context.textBaseline = "top";
    context.fillText(text(photo.label), x + 18, y + imageHeight + 26);
    context.fillStyle = "#667085";
    setFont(context, 15, 400);
    context.fillText(text(photo.meta, photo.image ? "已载入原图" : "空照片位"), x + 18, y + imageHeight + 58);
  }
  return cardHeight;
}

function drawPhotoRow(context, photos, y, columns, options, draw, paginate) {
  if (!photos.length) return y;
  const gap = 14;
  const width = (CONTENT_WIDTH - gap * (columns - 1)) / columns;
  const cardHeight = options.cardHeight;
  y = ensureSpace(y, cardHeight + 14, paginate);
  photos.forEach((photo, index) => {
    drawPhotoCard(context, photo, PAGE_MARGIN + index * (width + gap), y, width, draw, options);
  });
  return y + cardHeight + 14;
}

function drawCompactVerificationPhotos(context, photos, y, draw, paginate) {
  y = drawPhotoRow(context, photos.slice(0, 2), y, 2, { imageHeight: 238, cardHeight: 314 }, draw, paginate);
  return drawPhotoRow(context, photos.slice(2, 5), y, 3, { imageHeight: 176, cardHeight: 252 }, draw, paginate);
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
  y = ensureSpace(y, 70, paginate);
  y = drawSectionHeading(context, "产品说明", "", y, draw);
  return drawMessageCard(context, { label: "说明", value: instructions }, y, draw, paginate);
}

function layoutDocument(context, documentData, photos, productLogo, options = {}) {
  const draw = options.draw === true;
  const paginate = options.paginate === true;
  const compactVerification = documentData.compactVerification === true;
  if (draw) {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, context.canvas.width, context.canvas.height);
  }
  let y = drawDocumentHeader(context, documentData, productLogo, draw);
  y = drawInfoGrid(context, documentData.facts || [], y, draw, paginate);
  if (!compactVerification) {
    y += 12;
    y = ensureSpace(y, 70, paginate);
    y = drawSectionHeading(context, documentData.detailTitle || "工单信息", documentData.detailSubtitle, y, draw);
    const details = documentData.details || [];
    y = drawInfoGrid(context, details, y, draw, paginate, details.length === 3 ? 3 : 2);
  }

  const messages = Array.isArray(documentData.messages) ? documentData.messages : [];
  if (messages.length) {
    y += compactVerification ? 8 : 16;
    if (!compactVerification) {
      y = ensureSpace(y, 70, paginate);
      y = drawSectionHeading(context, "留言与审核记录", "按工单数据库内容完整导出", y, draw);
    }
    messages.forEach((message) => { y = drawMessageCard(context, message, y, draw, paginate); });
  }

  if (photos.length) {
    y += compactVerification ? 8 : 16;
    y = ensureSpace(y, 70, paginate);
    y = drawSectionHeading(context, "核销照片凭证", compactVerification ? "客户留存照、本次核销人脸照与补充照片" : "客户留存照、本次核销人脸照与三个补充照片位", y, draw);
    y = compactVerification
      ? drawCompactVerificationPhotos(context, photos, y, draw, paginate)
      : drawPhotos(context, photos, y, draw, paginate);
  }

  y = drawProductInstructions(context, documentData, y, draw, paginate);
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

async function renderReceiptCanvas(options = {}) {
  const canvas = options.canvas;
  if (!canvas || typeof canvas.getContext !== "function") throw new Error("单据画布尚未准备完成");
  const documentData = options.documentData || {};
  const rawPhotos = options.photos || [];
  const paginate = options.paginate === true;
  canvas.width = CANVAS_WIDTH;
  canvas.height = 500;
  let context = canvas.getContext("2d");
  const usedHeight = layoutDocument(context, documentData, rawPhotos, { image: null }, { draw: false, paginate });
  const height = paginate
    ? Math.max(PDF_PAGE_HEIGHT, Math.ceil(usedHeight / PDF_PAGE_HEIGHT) * PDF_PAGE_HEIGHT)
    : Math.max(500, Math.ceil(usedHeight));
  canvas.width = CANVAS_WIDTH;
  canvas.height = height;
  context = canvas.getContext("2d");
  const [productLogo, photos] = await Promise.all([
    prepareProductLogo(canvas, documentData, options.logoSource || ""),
    preparePhotos(canvas, rawPhotos)
  ]);
  layoutDocument(context, documentData, photos, productLogo, { draw: true, paginate });
  const pageCount = paginate ? Math.ceil(height / PDF_PAGE_HEIGHT) : 1;
  if (paginate) {
    for (let page = 0; page < pageCount; page += 1) {
      context.fillStyle = "#98a2b3";
      setFont(context, 14, 500);
      context.textAlign = "center";
      context.textBaseline = "bottom";
      context.fillText(`第 ${page + 1} / ${pageCount} 页`, CANVAS_WIDTH / 2, (page + 1) * PDF_PAGE_HEIGHT - 20);
    }
    context.textAlign = "left";
    context.textBaseline = "top";
  }
  return { canvas, width: CANVAS_WIDTH, height, pageCount, paginate };
}

function canvasToTempFile(scope, options) {
  return new Promise((resolve, reject) => {
    wx.canvasToTempFilePath({ ...options, success: resolve, fail: reject }, scope);
  });
}

async function exportReceiptJpegs(receipt, scope) {
  const pages = [];
  const count = receipt.paginate ? receipt.pageCount : 1;
  const height = receipt.paginate ? PDF_PAGE_HEIGHT : receipt.height;
  for (let index = 0; index < count; index += 1) {
    const output = await canvasToTempFile(scope, {
      canvas: receipt.canvas,
      x: 0,
      y: receipt.paginate ? index * PDF_PAGE_HEIGHT : 0,
      width: CANVAS_WIDTH,
      height,
      destWidth: CANVAS_WIDTH,
      destHeight: height,
      fileType: "jpg",
      quality: receipt.paginate ? 0.94 : 0.95
    });
    if (!output || !output.tempFilePath) throw new Error(receipt.paginate ? `PDF 第 ${index + 1} 页生成失败` : "导出图片生成失败");
    pages.push({ path: output.tempFilePath, width: CANVAS_WIDTH, height, pageNumber: index + 1 });
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
    width: Number(page.width || CANVAS_WIDTH),
    height: Number(page.height || PDF_PAGE_HEIGHT),
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
  createProductSampleDocument,
  createProductSamplePhotos,
  renderReceiptCanvas,
  exportReceiptJpegs,
  createPdfBytes,
  safeFilename
};
