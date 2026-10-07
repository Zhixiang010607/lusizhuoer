#!/usr/bin/env python3
"""Generate the one-page HC-08 handoff sheet for the device-side team."""

import os
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "露思卓儿_魔法柔肤_HC-08设备端一页接入说明.pdf"

INK = colors.HexColor("#35291E")
GOLD = colors.HexColor("#9A6D2D")
PALE_GOLD = colors.HexColor("#F2E7D3")
IVORY = colors.HexColor("#FFF9F0")
LINE = colors.HexColor("#D7BE97")
MUTED = colors.HexColor("#6F6255")
RED = colors.HexColor("#A43C32")


def load_production_key():
    key_text = os.environ.get("BLE_DEVICE_PRODUCTION_KEY", "").strip()
    key_file = os.environ.get("BLE_DEVICE_PRODUCTION_KEY_FILE", "").strip()
    if key_text and key_file:
        raise RuntimeError("只允许设置 BLE_DEVICE_PRODUCTION_KEY 或 BLE_DEVICE_PRODUCTION_KEY_FILE 之一")
    if key_file:
        key_text = Path(key_file).read_text(encoding="utf-8").strip().strip('"').strip("'")
    if len(key_text) != 64 or any(ch not in "0123456789abcdef" for ch in key_text):
        raise RuntimeError("生产 Key 缺失或格式错误：必须是 64 个小写十六进制字符")
    return key_text


def register_fonts():
    candidates = [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
    ]
    font_path = next((item for item in candidates if item.exists()), None)
    if not font_path:
        raise RuntimeError("未找到可用中文字体")
    pdfmetrics.registerFont(TTFont("CN", str(font_path), subfontIndex=0))
    pdfmetrics.registerFont(TTFont("CN-Bold", str(font_path), subfontIndex=0))


def style(name, size, leading=None, color=INK, align=TA_LEFT, **kwargs):
    return ParagraphStyle(
        name,
        fontName="CN",
        fontSize=size,
        leading=leading or size * 1.45,
        textColor=color,
        alignment=align,
        spaceAfter=0,
        **kwargs,
    )


def box(title, body, styles, tone="gold"):
    fill = PALE_GOLD if tone == "gold" else colors.HexColor("#FCECE9")
    border = LINE if tone == "gold" else colors.HexColor("#DDA69E")
    title_color = GOLD if tone == "gold" else RED
    content = Paragraph(
        f'<font name="CN-Bold" color="{title_color.hexval()}">{title}</font><br/>{body}',
        styles["box"],
    )
    table = Table([[content]], colWidths=[178 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.4 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.4 * mm),
    ]))
    return table


def draw_page(canvas, doc):
    width, height = A4
    canvas.saveState()
    canvas.setFillColor(IVORY)
    canvas.rect(0, 0, width, height, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(16 * mm, 11 * mm, width - 16 * mm, 11 * mm)
    canvas.setFont("CN", 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 6.7 * mm, "露思卓儿｜魔法柔肤 LASER-BLE｜设备端接入说明")
    canvas.drawRightString(width - 16 * mm, 6.7 * mm, "2026-10-07｜第 1 页 / 共 1 页")
    canvas.restoreState()


def build():
    register_fonts()
    production_key = load_production_key()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    styles = {
        "title": style("title", 18, 23, align=TA_CENTER),
        "sub": style("sub", 8.7, 12.5, MUTED, TA_CENTER),
        "h2": style("h2", 10.5, 14, GOLD),
        "body": style("body", 8.25, 12.2),
        "small": style("small", 7.5, 10.7, MUTED),
        "box": style("box", 8.2, 12.1),
        "cell": style("cell", 7.8, 11.1),
        "cellhead": style("cellhead", 7.8, 11.1, colors.white, TA_CENTER),
    }

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=13 * mm,
        bottomMargin=15 * mm,
        title="露思卓儿魔法柔肤 HC-08 设备端一页接入说明",
        author="广州露思卓儿科技有限公司",
    )

    story = [
        Paragraph("魔法柔肤 HC-08 设备端一页接入说明", styles["title"]),
        Paragraph("给设备固件开发／调试人员｜目的：让小程序稳定找到正确通道并完成授权开机", styles["sub"]),
        Spacer(1, 3.5 * mm),
        box(
            "一、固定身份与 GATT（必须按此实现）",
            "设备类型：<b>LASER-BLE</b>　｜　设备编号：<b>LA + 12 位大写十六进制</b><br/>"
            "广播名：<b>LA- + 设备编号末 6 位</b>　｜　示例：LAF82E0CC8C5B9 → LA-C8C5B9<br/>"
            "Service UUID：<b>FFE0</b>　｜　Write UUID：<b>FFE1</b>　｜　Notify UUID：<b>FFE1</b>",
            styles,
        ),
        Spacer(1, 3 * mm),
        Paragraph("二、FFE1 怎样使用", styles["h2"]),
    ]

    gatt_rows = [
        [Paragraph("方向", styles["cellhead"]), Paragraph("设备端动作", styles["cellhead"]), Paragraph("硬性要求", styles["cellhead"])],
        [Paragraph("小程序 → 设备", styles["cell"]), Paragraph("在 FFE1 接收 get_info、auth、query_status", styles["cell"]), Paragraph("FFE1 开启 write 或 writeNoResponse", styles["cell"])],
        [Paragraph("设备 → 小程序", styles["cell"]), Paragraph("在同一 FFE1 发送 info、auth_result、status", styles["cell"]), Paragraph("FFE1 开启 notify 或 indicate，并支持 CCCD 订阅", styles["cell"])],
        [Paragraph("字节协议", styles["cell"]), Paragraph("UTF-8 JSON；每条完整报文末尾追加 LF（0x0A）", styles["cell"]), Paragraph("所有下行均分片；收到 LF 后才允许解析", styles["cell"])],
    ]
    gatt_table = Table(gatt_rows, colWidths=[29 * mm, 78 * mm, 71 * mm], repeatRows=1)
    gatt_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GOLD),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.7 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.7 * mm),
    ]))
    story += [gatt_table, Spacer(1, 2.2 * mm)]
    story.append(box(
        "重要：不是“每条报文固定 20 字节”，而是“每次 BLE 写入最多 20 字节”",
        "小程序发往设备的<b>全部三种指令</b>都执行同一规则：<b>get_info、auth、query_status 全部分片</b>；"
        "最后一片可以少于 20 字节，不补零、不补空格。auth 通常约 280-320 字节，所以会分成多片；短指令也不能依赖一次到齐。<br/>"
        "设备端每次收到 FFE1 写入时，只把原始字节追加到 <font name=\"Courier\" size=\"7\">rx_buffer</font>；"
        "<b>不得逐片 JSON 解析、不得每次回调清空缓冲区</b>。只有找到 LF（0x0A）后，才取出 LF 之前的完整 UTF-8 JSON 解析；"
        "处理后删除这一帧，未完成的尾部继续保留。接收缓冲区建议至少 <b>512 字节</b>。",
        styles,
        tone="red",
    ))
    story += [Spacer(1, 2.2 * mm), Paragraph("三、一次完整通信顺序", styles["h2"])]

    flow_rows = [
        [Paragraph("1", styles["cellhead"]), Paragraph("连接后，小程序订阅 FFE1 通知；设备必须允许订阅成功。", styles["cell"])],
        [Paragraph("2", styles["cellhead"]), Paragraph("把 get_info 的全部分片拼到 LF 后再解析；10 秒内返回 info：device_id、device_type、ble_name、status、nonce。", styles["cell"])],
        [Paragraph("3", styles["cellhead"]), Paragraph("把 seq:2 / auth 的全部分片拼到 LF 后再解析；分别校验 device_id、device_type、nonce、expire_at、usage_count，并确认 signature 与生产 Key 完全相同。", styles["cell"])],
        [Paragraph("4", styles["cellhead"]), Paragraph("全部校验通过才进入工作态并持久化 status=2；随后返回 seq:2 / auth_result / ok=true / status=2。", styles["cell"])],
        [Paragraph("5", styles["cellhead"]), Paragraph("把 seq:3 / query_status 的全部分片拼到 LF 后再解析；10 秒内返回真实 status。未执行 auth 时只能返回待机状态 1。", styles["cell"])],
    ]
    flow_table = Table(flow_rows, colWidths=[10 * mm, 168 * mm])
    flow_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), GOLD),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (1, 0), (1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.3 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.25 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.25 * mm),
    ]))
    story += [flow_table, Spacer(1, 2.5 * mm)]
    story.append(box(
        "四、固定 signature（设备只做字符串比较）",
        "最终规则：<b>auth.signature 永远等于下面的生产 Key 原文</b>。不计算 HMAC-SHA256，不构造 canonical string，不做 hex decode；"
        "按 64 个小写十六进制 ASCII 字符逐字比较即可。<br/>生产 Key：<br/>"
        f'<font name="Courier" size="7.2">{production_key}</font><br/>'
        "注意：固定 signature 只确认 Key 相同；设备仍必须独立校验本机 device_id、LASER-BLE、当次 nonce、usage_count、issued_at 与 expire_at。",
        styles,
    ))
    story.append(Spacer(1, 2.5 * mm))

    lower = Table([
        [
            [
                Paragraph("五、设备端必须做到", styles["h2"]),
                Paragraph("• FFE0/FFE1 固定，不因批次改变。<br/>• 三种下行指令全部按字节追加到同一接收缓冲区。<br/>• nonce 为 16 随机字节（32 位 hex），一次一用。<br/>• 生产 Key 离线烧录，不得在设备回包或日志中输出。<br/>• Key 不符、过期、nonce 不一致或已使用时禁止启动。<br/>• 只有真实进入工作态才能回 status=2。", styles["body"]),
            ],
            [
                Paragraph("六、联调验收", styles["h2"]),
                Paragraph("□ 微信能发现正确广播名<br/>□ 可订阅 FFE1 通知<br/>□ 每次写入 1-20 字节都能按序追加<br/>□ 三种指令均到 LF 后才解析<br/>□ 三类应答均在 10 秒内返回<br/>□ 完整 auth 不截断、不逐片报错<br/>□ 未收到 auth 时 query_status 返回 1", styles["body"]),
            ],
        ]
    ], colWidths=[91 * mm, 87 * mm])
    lower.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("INNERGRID", (0, 0), (-1, -1), 0.45, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
    ]))
    story += [lower, Spacer(1, 3 * mm)]
    story.append(box(
        "重要边界",
        "设备可以保留 HC-08 的其他服务；小程序只按 LASER-BLE 档案查找 FFE0/FFE1。"
        "如果缺少 FFE0、缺少 FFE1、FFE1 不可写或不可通知，小程序会分别给出明确错误并拒绝开机。"
        "其他项目可能使用不同模块与 UUID，不能照搬本页配置。",
        styles,
        tone="red",
    ))

    doc.build(story, onFirstPage=draw_page)
    print(OUTPUT)


if __name__ == "__main__":
    build()
