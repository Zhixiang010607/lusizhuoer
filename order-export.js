(() => {
  "use strict";

  const CANVAS_WIDTH = 1240;
  const PDF_PAGE_HEIGHT = 1754;
  const PAGE_MARGIN = 64;
  const CONTENT_WIDTH = CANVAS_WIDTH - PAGE_MARGIN * 2;
  const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif';
  const RECEIPT_BACKGROUND_SOURCE = "assets/receipt/lusizhuoer-receipt-bg-v1.jpg";
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
    kind: 22,
    title: 52,
    subtitle: 22,
    factLabel: 20,
    factValue: 25,
    sectionTitle: 34,
    sectionSubtitle: 20,
    giftName: 25,
    giftCount: 27,
    photoLabel: 24,
    photoMeta: 18,
    instructionLabel: 25,
    instructionBody: 24,
    pageNumber: 18
  });
  const encoder = new TextEncoder();
  let receiptBackgroundPromise = null;

  function text(value, fallback = "—") {
    const normalized = String(value ?? "").trim();
    return normalized || fallback;
  }

  function safeFilename(value) {
    return text(value, "工单")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/[. ]+$/g, "")
      .slice(0, 120) || "工单";
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
    const paragraphs = String(value ?? "").replace(/\r/g, "").split("\n");
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
    const size = options.size || 27;
    const lineHeight = options.lineHeight || Math.round(size * 1.55);
    setFont(context, size, options.weight || 400);
    const lines = wrapLines(context, value, maxWidth);
    if (options.draw !== false) {
      context.fillStyle = options.color || RECEIPT_COLORS.title;
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
    const valueLines = singleLine ? [value] : wrapLines(context, value, width - 36);
    const valueLineHeight = 36;
    const height = Math.max(108, 60 + valueLines.length * valueLineHeight);
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
      context.fillText(text(item.label), x + 18, y + 16);
      if (singleLine) {
        const maxWidth = width - 36;
        const normalSize = RECEIPT_FONT_SIZES.factValue;
        setFont(context, normalSize, 750);
        const measured = Math.max(1, context.measureText(value).width);
        const fittedSize = Math.max(13, Math.min(normalSize, Math.floor(normalSize * maxWidth / measured)));
        context.save();
        roundedRect(context, x + 16, y + 45, maxWidth + 4, 44, 0);
        context.clip();
        context.fillStyle = RECEIPT_COLORS.title;
        setFont(context, fittedSize, 750);
        context.textBaseline = "top";
        context.fillText(value, x + 18, y + 50, maxWidth);
        context.restore();
      } else {
        drawWrappedText(context, value, x + 18, y + 50, width - 36, {
          draw: true,
          size: RECEIPT_FONT_SIZES.factValue,
          lineHeight: valueLineHeight,
          weight: 750,
          color: RECEIPT_COLORS.title
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
        context.fillText(String(subtitle), PAGE_MARGIN, y + 49);
      }
    }
    return y + (subtitle ? 84 : 60);
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
    const kindWidth = Math.min(leftWidth, Math.max(104, context.measureText(kind).width + 38));
    const titleY = top + 57;
    const titleMetrics = drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
      draw: false,
      size: RECEIPT_FONT_SIZES.title,
      lineHeight: 64,
      weight: 900
    });
    const subtitleY = titleY + titleMetrics.height + 8;
    const subtitleMetrics = drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
      draw: false,
      size: RECEIPT_FONT_SIZES.subtitle,
      lineHeight: 34
    });
    const logoX = PAGE_MARGIN + leftWidth + gap;
    const bottom = Math.max(subtitleY + subtitleMetrics.height, top + logoSize) + 30;
    if (!draw) return bottom;

    context.fillStyle = RECEIPT_COLORS.accent;
    context.fillRect(0, 0, CANVAS_WIDTH, 18);
    context.fillStyle = RECEIPT_COLORS.accentSoft;
    roundedRect(context, PAGE_MARGIN, top, kindWidth, 38, 19);
    context.fill();
    context.fillStyle = RECEIPT_COLORS.accent;
    setFont(context, RECEIPT_FONT_SIZES.kind, 800);
    context.textBaseline = "middle";
    context.fillText(kind, PAGE_MARGIN + 19, top + 19);

    drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
      draw: true,
      size: RECEIPT_FONT_SIZES.title,
      lineHeight: 64,
      weight: 900,
      color: RECEIPT_COLORS.title
    });
    drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
      draw: true,
      size: RECEIPT_FONT_SIZES.subtitle,
      lineHeight: 34,
      color: RECEIPT_COLORS.secondary
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
    if (productLogo?.image) {
      drawImageCover(context, productLogo.image, logoX + 8, top + 8, logoSize - 16, logoSize - 16);
    } else {
      context.fillStyle = RECEIPT_COLORS.panelSoft;
      context.fillRect(logoX + 8, top + 8, logoSize - 16, logoSize - 16);
      context.fillStyle = RECEIPT_COLORS.accent;
      setFont(context, 24, 900);
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

  function drawProductGiftCard(context, item, index, y, draw, paginate) {
    const height = 96;
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

  function drawMessageCard(context, item, y, draw, paginate) {
    const padding = 22;
    setFont(context, 22, 400);
    const bodyLines = wrapLines(context, text(item.value, "无"), CONTENT_WIDTH - padding * 2);
    const height = Math.max(124, 72 + bodyLines.length * 34);
    y = ensureSpace(y, height + 14, paginate);
    if (draw) {
      context.fillStyle = RECEIPT_COLORS.panel;
      context.strokeStyle = RECEIPT_COLORS.border;
      roundedRect(context, PAGE_MARGIN, y, CONTENT_WIDTH, height, 12);
      context.fill();
      context.stroke();
      context.fillStyle = RECEIPT_COLORS.title;
      setFont(context, RECEIPT_FONT_SIZES.photoLabel, 800);
      context.textBaseline = "top";
      context.fillText(text(item.label), PAGE_MARGIN + padding, y + 17);
      if (item.time) {
        context.fillStyle = RECEIPT_COLORS.secondary;
        setFont(context, 17, 400);
        const timeWidth = context.measureText(String(item.time)).width;
        context.fillText(String(item.time), PAGE_MARGIN + CONTENT_WIDTH - padding - timeWidth, y + 20);
      }
      drawWrappedText(context, text(item.value, "无"), PAGE_MARGIN + padding, y + 59, CONTENT_WIDTH - padding * 2, {
        draw: true,
        size: 22,
        lineHeight: 34,
        color: RECEIPT_COLORS.title
      });
    }
    return y + height + 14;
  }

  function drawImageCover(context, image, x, y, width, height) {
    const imageWidth = Number(image?.width || image?.naturalWidth || 0);
    const imageHeight = Number(image?.height || image?.naturalHeight || 0);
    if (!imageWidth || !imageHeight) return;
    const scale = Math.min(width / imageWidth, height / imageHeight);
    const drawWidth = imageWidth * scale;
    const drawHeight = imageHeight * scale;
    context.drawImage(image, x + (width - drawWidth) / 2, y + (height - drawHeight) / 2, drawWidth, drawHeight);
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
        drawImageCover(context, photo.image, x + 12, y + 12, width - 24, imageHeight);
      } else {
        context.fillStyle = RECEIPT_COLORS.secondary;
        setFont(context, 22, 600);
        context.textAlign = "center";
        context.textBaseline = "middle";
        context.fillText(text(photo.placeholder, "尚未上传"), x + width / 2, y + 12 + imageHeight / 2);
        context.textAlign = "left";
        context.textBaseline = "top";
      }
      context.restore();
      context.fillStyle = RECEIPT_COLORS.title;
      setFont(context, RECEIPT_FONT_SIZES.photoLabel, 800);
      context.textBaseline = "top";
      context.fillText(text(photo.label), x + 18, y + imageHeight + 26);
      context.fillStyle = RECEIPT_COLORS.secondary;
      setFont(context, RECEIPT_FONT_SIZES.photoMeta, 400);
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
    return drawPhotoRow(context, photos.slice(0, 1), y, 1, { imageHeight: 420, cardHeight: 514 }, draw, paginate);
  }

  function selectReceiptPhotos(documentData, photoItems) {
    const photos = Array.isArray(photoItems) ? photoItems : [];
    if (documentData?.compactVerification !== true) return photos;
    const coreSlots = new Map();
    photos.forEach((photo, index) => {
      const rawSlot = photo?.slot;
      const hasExplicitSlot = rawSlot !== undefined && rawSlot !== null && String(rawSlot).trim() !== "";
      const slot = hasExplicitSlot && Number.isInteger(Number(rawSlot)) ? Number(rawSlot) : index;
      if (slot === 1 && !coreSlots.has(slot)) coreSlots.set(slot, photo);
    });
    return [1].map((slot) => coreSlots.get(slot)).filter(Boolean);
  }

  function drawInstructionChunk(context, lines, label, y, draw) {
    const padding = 24;
    const lineHeight = 38;
    const height = Math.max(132, 76 + lines.length * lineHeight);
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
      setFont(context, RECEIPT_FONT_SIZES.instructionBody, 450);
      lines.forEach((line, index) => context.fillText(line, PAGE_MARGIN + padding, y + 58 + index * lineHeight));
    }
    return y + height + 14;
  }

  function drawInstructionText(context, value, y, draw, paginate) {
    const padding = 24;
    const lineHeight = 38;
    setFont(context, RECEIPT_FONT_SIZES.instructionBody, 450);
    const lines = wrapLines(context, text(value, "无"), CONTENT_WIDTH - padding * 2);
    if (!paginate) return drawInstructionChunk(context, lines, "说明", y, draw);
    let offset = 0;
    let part = 0;
    while (offset < lines.length) {
      y = ensureSpace(y, 146, true);
      const availableHeight = Math.max(132, pageBottom(y) - y - 14);
      const maxLines = Math.max(1, Math.floor((availableHeight - 76) / lineHeight));
      const chunk = lines.slice(offset, offset + maxLines);
      y = drawInstructionChunk(context, chunk, part === 0 ? "说明" : "说明（续）", y, draw);
      offset += chunk.length;
      part += 1;
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

  function drawReceiptBackground(context, backgroundImage) {
    const height = Number(context?.canvas?.height || 0);
    context.fillStyle = RECEIPT_COLORS.background;
    context.fillRect(0, 0, CANVAS_WIDTH, height);
    if (!backgroundImage || !height) return;
    const pageCount = Math.max(1, Math.ceil(height / PDF_PAGE_HEIGHT));
    for (let page = 0; page < pageCount; page += 1) {
      context.drawImage(backgroundImage, 0, page * PDF_PAGE_HEIGHT, CANVAS_WIDTH, PDF_PAGE_HEIGHT);
    }
  }

  function layoutDocument(context, documentData, photos, productLogo, options = {}) {
    const draw = options.draw === true;
    const paginate = options.paginate === true;
    const compactVerification = documentData.compactVerification === true;
    const printablePhotos = selectReceiptPhotos(documentData, photos);
    if (draw) {
      drawReceiptBackground(context, options.backgroundImage || null);
    }
    let y = drawDocumentHeader(context, documentData, productLogo, draw);
    y = drawInfoGrid(context, documentData.facts || [], y, draw, paginate);
    if (!compactVerification) {
      y += 12;
      y = ensureSpace(y, 70, paginate);
      y = drawSectionHeading(context, documentData.detailTitle || "工单信息", documentData.detailSubtitle, y, draw);
      const details = documentData.details || [];
      y = drawInfoGrid(context, details, y, draw, paginate, details.length === 3 ? 3 : 2);
      y = drawProductGifts(context, documentData.productGifts, y, draw, paginate);
    }

    if (printablePhotos.length) {
      y += compactVerification ? 8 : 16;
      y = ensureSpace(y, 70, paginate);
      y = drawSectionHeading(context, "客户核销照片", "仅保留核销时使用的身份照片", y, draw);
      y = compactVerification
        ? drawCompactVerificationPhotos(context, printablePhotos, y, draw, paginate)
        : drawPhotos(context, printablePhotos, y, draw, paginate);
    }

    y = drawProductInstructions(context, documentData, y, draw, paginate);

    y += 24;
    return y;
  }

  function makeCanvas(documentData, photos, productLogo, backgroundImage, paginate) {
    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");
    const usedHeight = layoutDocument(measureContext, documentData, photos, productLogo, { draw: false, paginate });
    const height = paginate ? Math.max(PDF_PAGE_HEIGHT, Math.ceil(usedHeight / PDF_PAGE_HEIGHT) * PDF_PAGE_HEIGHT) : Math.max(500, Math.ceil(usedHeight));
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    layoutDocument(context, documentData, photos, productLogo, { draw: true, paginate, backgroundImage });
    if (paginate) {
      const pageCount = Math.ceil(height / PDF_PAGE_HEIGHT);
      for (let page = 0; page < pageCount; page += 1) {
        context.fillStyle = RECEIPT_COLORS.secondary;
        setFont(context, RECEIPT_FONT_SIZES.pageNumber, 500);
        context.textAlign = "center";
        context.textBaseline = "bottom";
        context.fillText(`第 ${page + 1} / ${pageCount} 页`, CANVAS_WIDTH / 2, (page + 1) * PDF_PAGE_HEIGHT - 20);
      }
      context.textAlign = "left";
      context.textBaseline = "top";
    }
    return canvas;
  }

  function canvasBlob(canvas, mimeType, quality) {
    return new Promise((resolve, reject) => canvas.toBlob(
      (blob) => blob ? resolve(blob) : reject(new Error("浏览器无法生成导出文件")),
      mimeType,
      quality
    ));
  }

  async function decodeBlobToCanvas(blob) {
    let image;
    let objectUrl = "";
    try {
      if (typeof createImageBitmap === "function") {
        try { image = await createImageBitmap(blob, { imageOrientation: "from-image" }); }
        catch (_) { image = null; }
      }
      if (!image) {
        objectUrl = URL.createObjectURL(blob);
        image = await new Promise((resolve, reject) => {
          const element = new Image();
          element.addEventListener("load", () => resolve(element), { once: true });
          element.addEventListener("error", () => reject(new Error("照片解码失败")), { once: true });
          element.src = objectUrl;
        });
      }
      const sourceWidth = Number(image.width || image.naturalWidth || 0);
      const sourceHeight = Number(image.height || image.naturalHeight || 0);
      if (!sourceWidth || !sourceHeight) throw new Error("照片尺寸无效");
      const scale = Math.min(1, 1100 / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));
      canvas.getContext("2d", { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
      return canvas;
    } finally {
      image?.close?.();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  }

  async function preparePhotos(photoItems) {
    const prepared = [];
    for (const item of photoItems || []) {
      let image = null;
      let placeholder = item.placeholder || "尚未上传";
      if (item.blob instanceof Blob) {
        try { image = await decodeBlobToCanvas(item.blob); }
        catch (error) { throw new Error(`${text(item.label, "核销照片")}解码失败，本次没有生成文件。请重试。`); }
      }
      if (item.required && !image) throw new Error(`${text(item.label, "核销照片")}尚未完整载入，本次没有生成文件。请重试。`);
      prepared.push({ ...item, image, placeholder });
    }
    const requiredCount = prepared.filter((item) => item.required).length;
    const embeddedCount = prepared.filter((item) => item.required && item.image).length;
    if (embeddedCount !== requiredCount) throw new Error("核销照片完整性检查未通过，本次没有生成文件。请重试。");
    return prepared;
  }

  async function prepareProductLogo(template) {
    if (!template || typeof template !== "object") return { image: null };
    let image = null;
    if (template.logoBlob instanceof Blob) {
      try { image = await decodeBlobToCanvas(template.logoBlob); }
      catch (_) { throw new Error("产品 LOGO 原图解码失败，本次没有生成文件。请重试。"); }
    }
    if (template.logoRequired === true && !image) {
      throw new Error("产品 LOGO 原图尚未完整载入，本次没有生成文件。请重试。");
    }
    return { image };
  }

  function prepareReceiptBackground() {
    if (receiptBackgroundPromise) return receiptBackgroundPromise;
    receiptBackgroundPromise = new Promise((resolve, reject) => {
      const image = new Image();
      image.decoding = "async";
      image.addEventListener("load", () => resolve(image), { once: true });
      image.addEventListener("error", () => reject(new Error("露思卓儿凭证背景载入失败，本次没有生成文件。请刷新后重试。")), { once: true });
      image.src = new URL(RECEIPT_BACKGROUND_SOURCE, document.baseURI).href;
    }).catch((error) => {
      receiptBackgroundPromise = null;
      throw error;
    });
    return receiptBackgroundPromise;
  }

  function ascii(value) {
    return encoder.encode(value);
  }

  function concatBytes(chunks) {
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(length);
    let offset = 0;
    chunks.forEach((chunk) => { output.set(chunk, offset); offset += chunk.length; });
    return output;
  }

  function createPdfBytes(jpegPages) {
    const pageWidth = 595.28;
    const pageHeight = 841.89;
    const pageObjectNumbers = jpegPages.map((_, index) => 3 + index * 3);
    const objectCount = 2 + jpegPages.length * 3;
    const objects = new Map();
    objects.set(1, ascii("<< /Type /Catalog /Pages 2 0 R >>"));
    objects.set(2, ascii(`<< /Type /Pages /Kids [${pageObjectNumbers.map((number) => `${number} 0 R`).join(" ")}] /Count ${jpegPages.length} >>`));
    jpegPages.forEach((page, index) => {
      const pageNumber = 3 + index * 3;
      const imageNumber = pageNumber + 1;
      const contentNumber = pageNumber + 2;
      const imageName = `Im${index + 1}`;
      objects.set(pageNumber, ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /${imageName} ${imageNumber} 0 R >> >> /Contents ${contentNumber} 0 R >>`));
      objects.set(imageNumber, concatBytes([
        ascii(`<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.bytes.length} >>\nstream\n`),
        page.bytes,
        ascii("\nendstream")
      ]));
      const command = `q\n${pageWidth} 0 0 ${pageHeight} 0 0 cm\n/${imageName} Do\nQ\n`;
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
    const xref = [
      `xref\n0 ${objectCount + 1}\n`,
      "0000000000 65535 f \n",
      ...offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`),
      `trailer\n<< /Size ${objectCount + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    ].join("");
    chunks.push(ascii(xref));
    return concatBytes(chunks);
  }

  async function canvasToPdfBlob(canvas) {
    const pages = [];
    const pageCount = Math.ceil(canvas.height / PDF_PAGE_HEIGHT);
    for (let index = 0; index < pageCount; index += 1) {
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = CANVAS_WIDTH;
      pageCanvas.height = PDF_PAGE_HEIGHT;
      const context = pageCanvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      context.drawImage(canvas, 0, index * PDF_PAGE_HEIGHT, CANVAS_WIDTH, PDF_PAGE_HEIGHT, 0, 0, CANVAS_WIDTH, PDF_PAGE_HEIGHT);
      const jpeg = await canvasBlob(pageCanvas, "image/jpeg", 0.94);
      pages.push({ width: pageCanvas.width, height: pageCanvas.height, bytes: new Uint8Array(await jpeg.arrayBuffer()) });
      pageCanvas.width = 1;
      pageCanvas.height = 1;
    }
    return new Blob([createPdfBytes(pages)], { type: "application/pdf" });
  }

  async function exportCanvasPagesPdf(canvases, filename) {
    const pages = [];
    for (const source of canvases || []) {
      if (!(source instanceof HTMLCanvasElement) || !source.width || !source.height) continue;
      const pageCanvas = document.createElement("canvas");
      pageCanvas.width = CANVAS_WIDTH;
      pageCanvas.height = PDF_PAGE_HEIGHT;
      const context = pageCanvas.getContext("2d", { alpha: false });
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, pageCanvas.width, pageCanvas.height);
      const scale = Math.min(CANVAS_WIDTH / source.width, PDF_PAGE_HEIGHT / source.height);
      const width = Math.round(source.width * scale);
      const height = Math.round(source.height * scale);
      context.drawImage(source, Math.round((CANVAS_WIDTH - width) / 2), 0, width, height);
      const jpeg = await canvasBlob(pageCanvas, "image/jpeg", 0.94);
      pages.push({ width: pageCanvas.width, height: pageCanvas.height, bytes: new Uint8Array(await jpeg.arrayBuffer()) });
      pageCanvas.width = 1;
      pageCanvas.height = 1;
    }
    if (!pages.length) throw new Error("没有可导出的统计表格页面");
    const blob = new Blob([createPdfBytes(pages)], { type: "application/pdf" });
    const outputName = `${safeFilename(filename || "门店业务统计")}.pdf`;
    downloadBlob(blob, outputName);
    return { filename: outputName, bytes: blob.size, pages: pages.length };
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  async function renderOrderCanvas(options = {}) {
    const documentData = options?.documentData || {};
    const printablePhotoItems = selectReceiptPhotos(documentData, options?.photos || []);
    const [photos, productLogo, backgroundImage] = await Promise.all([
      preparePhotos(printablePhotoItems),
      prepareProductLogo(documentData.productTemplate),
      prepareReceiptBackground()
    ]);
    return makeCanvas(documentData, photos, productLogo, backgroundImage, Boolean(options?.paginate));
  }

  async function createOrderPdfBlob(options = {}) {
    const canvas = await renderOrderCanvas({ documentData: options.documentData, photos: options.photos, paginate: true });
    const blob = await canvasToPdfBlob(canvas);
    canvas.width = 1;
    canvas.height = 1;
    return blob;
  }

  async function createOrderImageBlob(options = {}) {
    const canvas = await renderOrderCanvas({ documentData: options.documentData, photos: options.photos, paginate: false });
    const blob = await canvasBlob(canvas, "image/jpeg", 0.95);
    canvas.width = 1;
    canvas.height = 1;
    return blob;
  }

  async function exportOrder(options) {
    const format = options?.format === "pdf" ? "pdf" : "image";
    const documentData = options?.documentData || {};
    const filename = safeFilename(documentData.filename);
    if (format === "pdf") {
      const blob = await createOrderPdfBlob({ documentData, photos: options?.photos });
      downloadBlob(blob, `${filename}.pdf`);
      return { filename: `${filename}.pdf`, bytes: blob.size };
    }
    const blob = await createOrderImageBlob({ documentData, photos: options?.photos });
    downloadBlob(blob, `${filename}.jpg`);
    return { filename: `${filename}.jpg`, bytes: blob.size };
  }

  window.OrderExporter = Object.freeze({
    exportOrder, renderOrderCanvas, createOrderPdfBlob, createOrderImageBlob,
    exportCanvasPagesPdf, downloadBlob, safeFilename
  });
})();
