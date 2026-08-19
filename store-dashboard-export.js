(() => {
  "use strict";

  const WIDTH = 1240;
  const HEIGHT = 1754;
  const MARGIN = 64;
  const CONTENT_WIDTH = WIDTH - MARGIN * 2;
  const FONT = '"Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", Arial, sans-serif';
  const metrics = Object.freeze({
    recharge: { label: "充值", unit: "次" },
    verification: { label: "核销", unit: "次" },
    experience: { label: "体验", unit: "次" },
    refund: { label: "退费", unit: "次" }
  });
  const dimensions = Object.freeze({ stores: "门店", teachers: "老师", products: "项目" });

  function clean(value, fallback = "—") {
    const text = String(value ?? "").trim();
    return text || fallback;
  }

  function setFont(context, size, weight = 400) {
    context.font = `${weight} ${size}px ${FONT}`;
  }

  function createPage() {
    const canvas = document.createElement("canvas");
    canvas.width = WIDTH;
    canvas.height = HEIGHT;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, WIDTH, HEIGHT);
    return { canvas, context };
  }

  function fitText(context, value, width) {
    const text = clean(value);
    if (context.measureText(text).width <= width) return text;
    let output = "";
    for (const character of Array.from(text)) {
      if (context.measureText(`${output}${character}…`).width > width) break;
      output += character;
    }
    return `${output}…`;
  }

  function drawPageHeader(context, title, subtitle, data) {
    context.fillStyle = "#10233f";
    context.fillRect(0, 0, WIDTH, 18);
    setFont(context, 32, 900);
    context.fillStyle = "#10233f";
    context.textBaseline = "top";
    context.fillText(title, MARGIN, 58);
    setFont(context, 18, 500);
    context.fillStyle = "#61708a";
    context.fillText(subtitle, MARGIN, 108);
    setFont(context, 17, 700);
    context.fillStyle = "#233b5d";
    const storeText = `门店：${clean(data?.store?.storeName)}${data?.store?.phone ? ` · 电话：${data.store.phone}` : " · 电话：未填写"}`;
    context.fillText(fitText(context, storeText, CONTENT_WIDTH), MARGIN, 148);
    setFont(context, 16, 500);
    context.fillStyle = "#61708a";
    context.fillText(`时间范围：${clean(data?.range?.startDate)} 至 ${clean(data?.range?.endDate)}`, MARGIN, 182);
    context.strokeStyle = "#d9e2ee";
    context.beginPath();
    context.moveTo(MARGIN, 224);
    context.lineTo(WIDTH - MARGIN, 224);
    context.stroke();
    return 256;
  }

  function drawFooter(context, pageNumber) {
    setFont(context, 14, 500);
    context.fillStyle = "#8793a6";
    context.textBaseline = "bottom";
    context.fillText("露思卓儿门店业务统计 · 表格导出", MARGIN, HEIGHT - 34);
    const pageText = `第 ${pageNumber} 页`;
    const width = context.measureText(pageText).width;
    context.fillText(pageText, WIDTH - MARGIN - width, HEIGHT - 34);
  }

  function drawTable(context, columns, rows, startY) {
    const headerHeight = 52;
    const rowHeight = 48;
    let x = MARGIN;
    context.fillStyle = "#edf3fa";
    context.fillRect(MARGIN, startY, CONTENT_WIDTH, headerHeight);
    context.strokeStyle = "#d9e2ee";
    context.lineWidth = 1;
    columns.forEach((column) => {
      context.strokeRect(x, startY, column.width, headerHeight);
      setFont(context, 16, 800);
      context.fillStyle = "#233b5d";
      context.textBaseline = "middle";
      context.fillText(fitText(context, column.label, column.width - 24), x + 12, startY + headerHeight / 2);
      x += column.width;
    });
    rows.forEach((row, rowIndex) => {
      x = MARGIN;
      const y = startY + headerHeight + rowIndex * rowHeight;
      context.fillStyle = rowIndex % 2 ? "#f8fafc" : "#ffffff";
      context.fillRect(MARGIN, y, CONTENT_WIDTH, rowHeight);
      columns.forEach((column) => {
        context.strokeStyle = "#d9e2ee";
        context.strokeRect(x, y, column.width, rowHeight);
        setFont(context, 16, column.numeric ? 800 : 500);
        context.fillStyle = column.numeric ? "#10233f" : "#344765";
        context.textBaseline = "middle";
        const value = fitText(context, row[column.key], column.width - 24);
        const valueWidth = context.measureText(value).width;
        context.fillText(value, column.numeric ? x + column.width - 12 - valueWidth : x + 12, y + rowHeight / 2);
        x += column.width;
      });
    });
  }

  function summaryPages(data, startPageNumber) {
    const products = Array.isArray(data?.products) ? data.products : [];
    const chunks = [];
    for (let index = 0; index < Math.max(products.length, 1); index += 4) chunks.push(products.slice(index, index + 4));
    return chunks.map((chunk, chunkIndex) => {
      const { canvas, context } = createPage();
      const title = chunkIndex ? "门店业务总览（续）" : "门店业务总览";
      const y = drawPageHeader(context, title, "按项目汇总充值、核销、体验和退费", data);
      const projectWidth = Math.floor((CONTENT_WIDTH - 190 - 150) / Math.max(chunk.length, 1));
      const columns = [
        { key: "metric", label: "业务类型", width: 190 },
        ...chunk.map((product, index) => ({ key: `product${index}`, label: clean(product.productName), width: projectWidth, numeric: true })),
        { key: "total", label: "汇总", width: CONTENT_WIDTH - 190 - projectWidth * Math.max(chunk.length, 1), numeric: true }
      ];
      const rows = Object.entries(metrics).map(([key, definition]) => {
        const row = { metric: definition.label, total: `${Number(data?.totals?.[key] || 0)} ${definition.unit}` };
        chunk.forEach((product, index) => { row[`product${index}`] = `${Number(product?.[key] || 0)} ${definition.unit}`; });
        return row;
      });
      drawTable(context, columns, rows, y);
      drawFooter(context, startPageNumber + chunkIndex);
      return canvas;
    });
  }

  function dimensionPages(data, metric, dimension, startPageNumber) {
    const definition = metrics[metric];
    const source = Array.isArray(data?.dimensions?.[metric]?.[dimension]) ? data.dimensions[metric][dimension] : [];
    const rows = [...source].sort((a, b) => Number(b.value || 0) - Number(a.value || 0) || clean(a.name).localeCompare(clean(b.name), "zh-CN"));
    const pageSize = 24;
    const chunks = [];
    for (let index = 0; index < Math.max(rows.length, 1); index += pageSize) chunks.push(rows.slice(index, index + pageSize));
    return chunks.map((chunk, chunkIndex) => {
      const { canvas, context } = createPage();
      const title = `${definition.label}统计 · 按${dimensions[dimension]}`;
      const subtitle = chunkIndex ? `按数值从高到低 · 续第 ${chunkIndex + 1} 页` : "按数值从高到低；活跃对象即使为零也保留";
      const y = drawPageHeader(context, title, subtitle, data);
      const includePhone = dimension !== "products";
      const columns = includePhone
        ? [
            { key: "rank", label: "排名", width: 90, numeric: true },
            { key: "name", label: dimensions[dimension], width: 500 },
            { key: "phone", label: "电话", width: 310 },
            { key: "value", label: `${definition.label}次数`, width: CONTENT_WIDTH - 900, numeric: true }
          ]
        : [
            { key: "rank", label: "排名", width: 90, numeric: true },
            { key: "name", label: "项目", width: 780 },
            { key: "value", label: `${definition.label}次数`, width: CONTENT_WIDTH - 870, numeric: true }
          ];
      const tableRows = chunk.length ? chunk.map((row, index) => ({
        rank: String(chunkIndex * pageSize + index + 1),
        name: clean(row.name),
        phone: clean(row.phone, "未填写"),
        value: `${Number(row.value || 0)} ${definition.unit}`
      })) : [{ rank: "—", name: "暂无统计对象", phone: "—", value: `0 ${definition.unit}` }];
      drawTable(context, columns, tableRows, y);
      drawFooter(context, startPageNumber + chunkIndex);
      return canvas;
    });
  }

  function renderReportPages({ data, metric = "" } = {}) {
    if (!data?.store || !data?.range) throw new Error("统计数据尚未读取完成");
    const pages = [];
    if (!metric) pages.push(...summaryPages(data, pages.length + 1));
    const selectedMetrics = metric ? [metric] : Object.keys(metrics);
    selectedMetrics.forEach((metricKey) => {
      Object.keys(dimensions).forEach((dimension) => {
        pages.push(...dimensionPages(data, metricKey, dimension, pages.length + 1));
      });
    });
    return pages;
  }

  async function exportReport({ data, metric = "" } = {}) {
    if (!window.OrderExporter?.exportCanvasPagesPdf) throw new Error("PDF 导出组件尚未加载");
    const pages = renderReportPages({ data, metric });
    const suffix = metric ? metrics[metric]?.label || "业务" : "全部业务";
    try {
      return await window.OrderExporter.exportCanvasPagesPdf(
        pages,
        `${clean(data.store.storeName, "门店")}+${data.range.startDate}至${data.range.endDate}+${suffix}统计`
      );
    } finally {
      pages.forEach((canvas) => { canvas.width = 1; canvas.height = 1; });
    }
  }

  window.StoreDashboardExport = Object.freeze({ exportReport, renderReportPages, metrics, dimensions });
})();
