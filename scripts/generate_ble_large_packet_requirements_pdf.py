#!/usr/bin/env python3
"""Generate the one-page BLE fixed-20-byte device requirements handoff."""

from __future__ import annotations

import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(
    ROOT,
    "output",
    "pdf",
    "Lusizhuoer_BLE_Fixed_20_Byte_Device_Requirements_One_Page.pdf",
)
PAGE_W, PAGE_H = A4
MARGIN_X = 14 * mm
MARGIN_TOP = 13 * mm
MARGIN_BOTTOM = 12 * mm

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FONT = "ArialUnicode"
pdfmetrics.registerFont(TTFont(FONT, FONT_PATH))

INK = colors.HexColor("#2A241D")
MUTED = colors.HexColor("#74695D")
BRONZE = colors.HexColor("#7A592C")
CREAM = colors.HexColor("#FBF7EF")
SAND = colors.HexColor("#F2E6D2")
GREEN = colors.HexColor("#276B55")
GREEN_BG = colors.HexColor("#E8F3EE")
BLUE = colors.HexColor("#315C84")
BLUE_BG = colors.HexColor("#EAF1F8")
GRID = colors.HexColor("#D9C5A5")


def esc(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    "TitleCN", fontName=FONT, fontSize=19, leading=24, textColor=INK,
    spaceAfter=2 * mm,
))
styles.add(ParagraphStyle(
    "SubtitleCN", fontName=FONT, fontSize=8.2, leading=11, textColor=MUTED,
    spaceAfter=2 * mm,
))
styles.add(ParagraphStyle(
    "H1CN", fontName=FONT, fontSize=11.5, leading=15, textColor=INK,
    spaceBefore=1.8 * mm, spaceAfter=1.1 * mm, keepWithNext=True,
))
styles.add(ParagraphStyle(
    "BodyCN", fontName=FONT, fontSize=7.8, leading=10.8, textColor=INK,
    spaceAfter=0.8 * mm,
))
styles.add(ParagraphStyle(
    "SmallCN", fontName=FONT, fontSize=6.8, leading=9.0, textColor=MUTED,
))
styles.add(ParagraphStyle(
    "TableCN", fontName=FONT, fontSize=7.15, leading=9.6, textColor=INK,
))
styles.add(ParagraphStyle(
    "TableHeadCN", fontName=FONT, fontSize=7.2, leading=9.5,
    textColor=colors.white, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "CodeCN", fontName=FONT, fontSize=7.0, leading=9.5, textColor=INK,
    backColor=colors.HexColor("#F5F1EA"), borderColor=GRID, borderWidth=0.4,
    borderPadding=5, leftIndent=1.5 * mm, rightIndent=1.5 * mm,
    spaceBefore=0.5 * mm, spaceAfter=0.8 * mm,
))


def p(text: object, style: str = "BodyCN") -> Paragraph:
    return Paragraph(esc(text), styles[style])


def rich(text: str, style: str = "BodyCN") -> Paragraph:
    return Paragraph(text, styles[style])


def callout(title: str, body: str, bg, fg) -> Table:
    content = rich(
        f"<b><font color='{fg.hexval()}'>{esc(title)}</font></b>　{esc(body)}"
    )
    box = Table([[content]], colWidths=[PAGE_W - 2 * MARGIN_X])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.55, fg),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return box


def requirements_table() -> Table:
    rows = [
        ["要求", "设备端必须做到"],
        ["接收模型", "把 FFE1 的连续写入当作同一条字节流；不得把每次 GATT write 当作一条完整 JSON。"],
        ["组帧边界", "中间分包没有 LF。仅整条下行 JSON 的最后一个字节是 LF（0x0A）；收到 LF 后再解析一次 JSON。"],
        ["固定包长", "小程序每次 GATT write 最多 20 字节；不请求或回读大 MTU，不会把授权一次写完。"],
        ["缓冲区", "建议至少 512 字节。连接断开、重新连接、收到 LF 并处理完成、数据溢出或 JSON 判定无效时必须清空。"],
        ["处理时机", "未收到 LF 前不解析、不执行、不回包；完整解析后只执行一次，并按原协议返回对应 q 的 JSON。"],
        ["时序", "分包之间不能依赖固定 50ms/100ms/1s 延时。小程序按微信写回调顺序连续发送。"],
        ["防重复启动", "设备已进入 s=2 后，迟到或重复 q=2 不得再次启动；保持原服务，并让 q=3 返回真实 s=2。"],
    ]
    data = []
    for row_index, row in enumerate(rows):
        style = "TableHeadCN" if row_index == 0 else "TableCN"
        data.append([p(cell, style) for cell in row])
    table = Table(
        data,
        colWidths=[35 * mm, PAGE_W - 2 * MARGIN_X - 35 * mm],
        repeatRows=1,
    )
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4B4135")),
        ("GRID", (0, 0), (-1, -1), 0.35, GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3.3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.3),
    ]
    for row_index in range(2, len(rows), 2):
        commands.append(("BACKGROUND", (0, row_index), (-1, row_index), CREAM))
    table.setStyle(TableStyle(commands))
    return table


class OnePageDoc(BaseDocTemplate):
    def __init__(self, path: str):
        super().__init__(
            path,
            pagesize=A4,
            leftMargin=MARGIN_X,
            rightMargin=MARGIN_X,
            topMargin=MARGIN_TOP,
            bottomMargin=MARGIN_BOTTOM,
            title="露思卓儿 BLE 固定 20 字节设备端要求（一页版）",
            author="广州露思卓儿科技有限公司",
            subject="LASER-BLE fixed 20-byte writes and duplicate authorization prevention",
        )
        frame = Frame(
            self.leftMargin,
            self.bottomMargin,
            self.width,
            self.height,
            leftPadding=0,
            rightPadding=0,
            topPadding=0,
            bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="body", frames=[frame], onPage=draw_page))


def draw_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BRONZE)
    canvas.rect(0, PAGE_H - 5 * mm, PAGE_W, 5 * mm, fill=1, stroke=0)
    canvas.setFont(FONT, 6.5)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_X, 5.5 * mm, "露思卓儿 · LASER-BLE 设备端交付说明")
    canvas.drawRightString(PAGE_W - MARGIN_X, 5.5 * mm, "第 1 / 1 页")
    canvas.restoreState()


def build_story():
    story = [
        Spacer(1, 4 * mm),
        p("露 思 卓 儿", "SubtitleCN"),
        p("BLE 固定 20 字节：设备端要求", "TitleCN"),
        p("一页实施版 · 对齐 faceRecognition v121 / 小程序 0.2.95", "SubtitleCN"),
        callout(
            "当前规则",
            "小程序下行固定每次最多写 20 字节，不再使用 ATT MTU 自适应大包。设备必须缓存到 LF 后只解析、执行一次。",
            SAND,
            BRONZE,
        ),
        p("设备端必须实现", "H1CN"),
        requirements_table(),
        p("固定分片示例", "H1CN"),
        rich(
            "每次写入最多 <b>20 字节</b>。q=1 与 q=3 各为 8 字节（含 LF），各 1 片；示例 q=2 约 76-77 字节（含 LF），固定为 4 片。",
            "BodyCN",
        ),
        p(
            "q=2：第1-3片各 20 字节且无 LF；第4片为剩余 16-17 字节，最后一个字节是 0A。设备拼接后只解析、执行一次。",
            "CodeCN",
        ),
        p("验收用例", "H1CN"),
        p("1. q=2 四片可正常组帧且只执行一次。　2. 任意中间片缺失：不执行、不回成功，保持 s=1。", "BodyCN"),
        p("3. 断连后重连：旧残片已清空。　4. 已经 s=2 时收到迟到/重复 q=2：不再次启动，q=3 仍回 s=2。", "BodyCN"),
        callout(
            "没有变化",
            "JSON 字段、q=1/q=2/q=3 流程、设备编号、BLE 广播名、FFE0/FFE1、随机码和凯撒签名规则全部保持现行协议。",
            GREEN_BG,
            GREEN,
        ),
        Spacer(1, 1.2 * mm),
        p("结论：不要按‘一次 write = 一条报文’解析；要按‘收到 LF = 一条完整下行报文’解析。", "SmallCN"),
    ]
    return story


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    doc = OnePageDoc(OUT)
    doc.build(build_story())
    print(OUT)


if __name__ == "__main__":
    main()
