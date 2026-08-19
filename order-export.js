(() => {
  "use strict";

  const CANVAS_WIDTH = 1240;
  const PDF_PAGE_HEIGHT = 1754;
  const PAGE_MARGIN = 64;
  const CONTENT_WIDTH = CANVAS_WIDTH - PAGE_MARGIN * 2;
  const FONT_FAMILY = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif';
  const encoder = new TextEncoder();

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
        draw: true,
        size: 19,
        lineHeight: 29,
        weight: 700,
        color: "#101828"
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

  function drawDocumentHeader(context, documentData, draw) {
    const top = 44;
    const gap = 28;
    const statusWidth = 276;
    const leftWidth = CONTENT_WIDTH - statusWidth - gap;
    const kind = text(documentData.kind, documentData.detailTitle || "业务工单");
    const title = text(documentData.title, "业务工单");
    const subtitle = text(documentData.subtitle, "业务工单完整导出");
    const statusLabel = text(documentData.statusLabel, "当前审核状态");
    const status = text(documentData.status);
    const statusHint = text(documentData.statusHint, "—");
    setFont(context, 18, 800);
    const kindWidth = Math.min(leftWidth, Math.max(96, context.measureText(kind).width + 34));
    const titleY = top + 51;
    const titleMetrics = drawWrappedText(context, title, PAGE_MARGIN, titleY, leftWidth, {
      draw: false,
      size: 42,
      lineHeight: 52,
      weight: 900
    });
    const subtitleY = titleY + titleMetrics.height + 8;
    const subtitleMetrics = drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
      draw: false,
      size: 18,
      lineHeight: 28
    });
    const statusX = PAGE_MARGIN + leftWidth + gap;
    const hintMetrics = drawWrappedText(context, statusHint, statusX + 20, top + 82, statusWidth - 40, {
      draw: false,
      size: 16,
      lineHeight: 24
    });
    const statusHeight = Math.max(132, 102 + hintMetrics.height);
    const bottom = Math.max(subtitleY + subtitleMetrics.height, top + statusHeight) + 30;
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
      draw: true,
      size: 42,
      lineHeight: 52,
      weight: 900,
      color: "#10233f"
    });
    drawWrappedText(context, subtitle, PAGE_MARGIN, subtitleY, leftWidth, {
      draw: true,
      size: 18,
      lineHeight: 28,
      color: "#667085"
    });

    context.fillStyle = "#f8fafc";
    context.strokeStyle = "#d9e2ee";
    context.lineWidth = 1;
    roundedRect(context, statusX, top, statusWidth, statusHeight, 16);
    context.fill();
    context.stroke();
    context.fillStyle = "#667085";
    setFont(context, 15, 600);
    context.textBaseline = "top";
    context.fillText(statusLabel, statusX + 20, top + 18);
    const statusColor = documentData.statusTone === "rejected" ? "#b42318"
      : documentData.statusTone === "pending" ? "#8a5b00" : "#067a5c";
    context.fillStyle = statusColor;
    setFont(context, 26, 900);
    context.fillText(status, statusX + 20, top + 44);
    drawWrappedText(context, statusHint, statusX + 20, top + 82, statusWidth - 40, {
      draw: true,
      size: 16,
      lineHeight: 24,
      color: "#667085"
    });
    return bottom;
  }

  function drawInfoGrid(context, items, y, draw, paginate) {
    const gap = 14;
    const width = (CONTENT_WIDTH - gap) / 2;
    for (let index = 0; index < items.length; index += 2) {
      const left = items[index];
      const right = items[index + 1];
      const leftHeight = drawLabelValueCard(context, left, PAGE_MARGIN, y, width, false);
      const rightHeight = right ? drawLabelValueCard(context, right, PAGE_MARGIN + width + gap, y, width, false) : 0;
      const rowHeight = Math.max(leftHeight, rightHeight);
      y = ensureSpace(y, rowHeight + 14, paginate);
      drawLabelValueCard(context, left, PAGE_MARGIN, y, width, draw);
      if (right) drawLabelValueCard(context, right, PAGE_MARGIN + width + gap, y, width, draw);
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
        draw: true,
        size: 19,
        lineHeight: 31,
        color: "#344054"
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
        drawImageCover(context, photo.image, x + 12, y + 12, width - 24, imageHeight);
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
    y = drawPhotoRow(context, photos.slice(0, 2), y, 2, { imageHeight: 238, cardHeight: 314 }, draw, paginate);
    return drawPhotoRow(context, photos.slice(2, 5), y, 3, { imageHeight: 176, cardHeight: 252 }, draw, paginate);
  }

  function layoutDocument(context, documentData, photos, options = {}) {
    const draw = options.draw === true;
    const paginate = options.paginate === true;
    const compactVerification = documentData.compactVerification === true;
    if (draw) {
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, context.canvas.width, context.canvas.height);
    }
    let y = drawDocumentHeader(context, documentData, draw);
    y = drawInfoGrid(context, documentData.facts || [], y, draw, paginate);
    if (!compactVerification) {
      y += 12;
      y = ensureSpace(y, 70, paginate);
      y = drawSectionHeading(context, documentData.detailTitle || "工单信息", documentData.detailSubtitle, y, draw);
      y = drawInfoGrid(context, documentData.details || [], y, draw, paginate);
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

    y += 34;
    if (draw) {
      context.fillStyle = "#98a2b3";
      setFont(context, 14, 400);
      context.textBaseline = "top";
      context.fillText(`导出时间：${new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium", hour12: false }).format(new Date())}`, PAGE_MARGIN, y);
      context.textAlign = "right";
      context.fillText(
        photos.length ? "系统工单导出 · 私有照片仅写入当前下载文件" : documentData.customerFacing ? "露思卓儿客户业务凭证" : "系统工单导出",
        CANVAS_WIDTH - PAGE_MARGIN,
        y
      );
      context.textAlign = "left";
    }
    y += 42;
    return y;
  }

  function makeCanvas(documentData, photos, paginate) {
    const measureCanvas = document.createElement("canvas");
    const measureContext = measureCanvas.getContext("2d");
    const usedHeight = layoutDocument(measureContext, documentData, photos, { draw: false, paginate });
    const height = paginate ? Math.max(PDF_PAGE_HEIGHT, Math.ceil(usedHeight / PDF_PAGE_HEIGHT) * PDF_PAGE_HEIGHT) : Math.max(500, Math.ceil(usedHeight));
    const canvas = document.createElement("canvas");
    canvas.width = CANVAS_WIDTH;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    layoutDocument(context, documentData, photos, { draw: true, paginate });
    if (paginate) {
      const pageCount = Math.ceil(height / PDF_PAGE_HEIGHT);
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
    const photos = await preparePhotos(options?.photos || []);
    return makeCanvas(documentData, photos, Boolean(options?.paginate));
  }

  async function exportOrder(options) {
    const format = options?.format === "pdf" ? "pdf" : "image";
    const documentData = options?.documentData || {};
    const filename = safeFilename(documentData.filename);
    if (format === "pdf") {
      const canvas = await renderOrderCanvas({ documentData, photos: options?.photos, paginate: true });
      const blob = await canvasToPdfBlob(canvas);
      downloadBlob(blob, `${filename}.pdf`);
      canvas.width = 1;
      canvas.height = 1;
      return { filename: `${filename}.pdf`, bytes: blob.size };
    }
    const canvas = await renderOrderCanvas({ documentData, photos: options?.photos, paginate: false });
    const blob = await canvasBlob(canvas, "image/jpeg", 0.95);
    downloadBlob(blob, `${filename}.jpg`);
    canvas.width = 1;
    canvas.height = 1;
    return { filename: `${filename}.jpg`, bytes: blob.size };
  }

  window.OrderExporter = Object.freeze({ exportOrder, renderOrderCanvas, safeFilename });
})();
