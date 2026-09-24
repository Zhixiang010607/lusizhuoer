#!/usr/bin/env python3
"""Generate the BLE device-side firmware implementation specification.

The output is written for the equipment manufacturer's embedded/firmware team.
It contains only the device responsibilities and the wire contract required by
the current backend and controller.  Mini-program UI/API implementation,
marketing material and future protocol proposals are deliberately excluded.
"""

from __future__ import annotations

import hashlib
import hmac
import os
from datetime import date

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT_DIR = os.path.join(ROOT, "output", "pdf")
OUT_FILE = os.path.join(
    OUT_DIR,
    "Lusizhuoer_BLE_Device_Firmware_Developer_Spec_V1.0.pdf",
)

PAGE_W, PAGE_H = A4
MARGIN_X = 14 * mm
MARGIN_TOP = 16 * mm
MARGIN_BOTTOM = 14 * mm

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FONT = "ArialUnicode"
pdfmetrics.registerFont(TTFont(FONT, FONT_PATH))

INK = colors.HexColor("#20242A")
MUTED = colors.HexColor("#66717E")
NAVY = colors.HexColor("#173B57")
BLUE = colors.HexColor("#2878A5")
CYAN = colors.HexColor("#34A6B8")
PALE_BLUE = colors.HexColor("#EAF5FA")
PALE_GREEN = colors.HexColor("#EAF5EF")
PALE_AMBER = colors.HexColor("#FFF4DE")
PALE_RED = colors.HexColor("#FCEBE8")
GREEN = colors.HexColor("#217A52")
AMBER = colors.HexColor("#9A681C")
RED = colors.HexColor("#A13E33")
GRID = colors.HexColor("#C9D7E1")
WHITE = colors.white


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
    "CoverTitle", fontName=FONT, fontSize=23, leading=31, textColor=INK,
    alignment=TA_LEFT, spaceAfter=5 * mm,
))
styles.add(ParagraphStyle(
    "CoverSub", fontName=FONT, fontSize=10.2, leading=16, textColor=MUTED,
    alignment=TA_LEFT, spaceAfter=2 * mm,
))
styles.add(ParagraphStyle(
    "H1", fontName=FONT, fontSize=16, leading=22, textColor=NAVY,
    spaceBefore=3 * mm, spaceAfter=2.5 * mm, keepWithNext=True,
))
styles.add(ParagraphStyle(
    "H2", fontName=FONT, fontSize=11.4, leading=16, textColor=BLUE,
    spaceBefore=2.6 * mm, spaceAfter=1.4 * mm, keepWithNext=True,
))
styles.add(ParagraphStyle(
    "Body", fontName=FONT, fontSize=8.4, leading=12.7, textColor=INK,
    spaceAfter=1.5 * mm,
))
styles.add(ParagraphStyle(
    "Small", fontName=FONT, fontSize=7.2, leading=10.4, textColor=MUTED,
    spaceAfter=1 * mm,
))
styles.add(ParagraphStyle(
    "Table", fontName=FONT, fontSize=6.8, leading=9.4, textColor=INK,
))
styles.add(ParagraphStyle(
    "TableHead", fontName=FONT, fontSize=6.9, leading=9.2, textColor=WHITE,
    alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "CodeDev", fontName=FONT, fontSize=6.6, leading=9.5, textColor=INK,
    leftIndent=2 * mm, rightIndent=2 * mm, borderPadding=5,
    borderColor=GRID, borderWidth=0.5, backColor=colors.HexColor("#F4F7F9"),
    spaceBefore=1 * mm, spaceAfter=1.5 * mm,
))
styles.add(ParagraphStyle(
    "Callout", fontName=FONT, fontSize=7.8, leading=11.5, textColor=INK,
    leftIndent=2 * mm, rightIndent=2 * mm, borderPadding=6,
    spaceBefore=1 * mm, spaceAfter=2 * mm,
))


def p(text: str, style: str = "Body") -> Paragraph:
    return Paragraph(esc(text), styles[style])


def rich(text: str, style: str = "Body") -> Paragraph:
    return Paragraph(text, styles[style])


def h1(text: str) -> Paragraph:
    return Paragraph(esc(text), styles["H1"])


def h2(text: str) -> Paragraph:
    return Paragraph(esc(text), styles["H2"])


def code(text: str) -> Paragraph:
    return Paragraph(esc(text), styles["CodeDev"])


def bullets(items: list[str], compact: bool = True) -> list[Paragraph]:
    result = []
    for item in items:
        style = styles["Small"] if compact else styles["Body"]
        result.append(Paragraph(f"• {esc(item)}", style))
    return result


def callout(title: str, body: str, tone: str = "info") -> Table:
    palette = {
        "info": (PALE_BLUE, BLUE),
        "ok": (PALE_GREEN, GREEN),
        "warn": (PALE_AMBER, AMBER),
        "danger": (PALE_RED, RED),
    }
    background, border = palette[tone]
    content = Paragraph(
        f"<b>{esc(title)}</b><br/>{esc(body)}",
        styles["Callout"],
    )
    result = Table([[content]], colWidths=[PAGE_W - 2 * MARGIN_X])
    result.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), background),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    return result


def table(headers: list[str], rows: list[list[object]], widths=None, font_size=None) -> Table:
    head = [Paragraph(esc(value), styles["TableHead"]) for value in headers]
    body_style = styles["Table"]
    if font_size is not None:
        body_style = ParagraphStyle(
            f"Table{font_size}", parent=styles["Table"], fontSize=font_size,
            leading=font_size + 2.4,
        )
    data = [head]
    for row in rows:
        data.append([Paragraph(esc(value), body_style) for value in row])
    result = Table(data, colWidths=[w * mm for w in widths] if widths else None,
                   repeatRows=1, hAlign="LEFT")
    result.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), NAVY),
        ("TEXTCOLOR", (0, 0), (-1, 0), WHITE),
        ("GRID", (0, 0), (-1, -1), 0.35, GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [WHITE, colors.HexColor("#F7FAFC")]),
    ]))
    return result


def draw_page(canvas, doc):
    canvas.saveState()
    canvas.setStrokeColor(GRID)
    canvas.setLineWidth(0.4)
    canvas.line(MARGIN_X, 10.5 * mm, PAGE_W - MARGIN_X, 10.5 * mm)
    canvas.setFont(FONT, 6.7)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_X, 6.5 * mm, "BLE 设备端固件开发与交付规范 V1.0")
    canvas.drawRightString(PAGE_W - MARGIN_X, 6.5 * mm, f"{doc.page}")
    canvas.restoreState()


class DevSpecTemplate(BaseDocTemplate):
    def __init__(self, filename: str):
        super().__init__(
            filename,
            pagesize=A4,
            leftMargin=MARGIN_X,
            rightMargin=MARGIN_X,
            topMargin=MARGIN_TOP,
            bottomMargin=MARGIN_BOTTOM,
            title="露思卓儿 BLE 设备端固件开发与交付规范 V1.0",
            author="广州露思卓儿科技有限公司",
            subject="BLE device-side firmware implementation specification",
        )
        frame = Frame(
            self.leftMargin, self.bottomMargin, self.width, self.height,
            id="body", leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="body", frames=[frame], onPage=draw_page))


def add_cover(story):
    story.append(Spacer(1, 24 * mm))
    story.append(Paragraph("小程序 ↔ BLE 设备", styles["CoverTitle"]))
    story.append(Paragraph("通信开发规范 V1.0", styles["CoverTitle"]))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph("魔法柔肤 LASER-BLE｜扫码、发现、连接、授权、回执与恢复", styles["CoverSub"]))
    story.append(Spacer(1, 9 * mm))
    story.append(callout(
        "文档用途",
        "只供小程序、云函数与设备固件开发联调使用。文档不包含公司介绍、营销内容、后台运营说明或消费者流程。",
        "info",
    ))
    story.append(Spacer(1, 4 * mm))
    story.append(table(
        ["项目", "当前基线"],
        [
            ["设备身份", "device_id = LA + 12 位大写十六进制；ble_name = LA- + 末 6 位"],
            ["设备类型", "LASER-BLE"],
            ["线协议", "UTF-8 JSON Lines；每条 JSON 以 LF（0x0A）结束"],
            ["安全授权", "HMAC-SHA256；一次性 nonce；授权最长 30 秒"],
            ["服务端", "faceRecognition v114"],
            ["文档日期", str(date.today())],
        ],
        widths=[38, 132],
    ))
    story.append(Spacer(1, 9 * mm))
    story.append(callout(
        "最重要的实现红线",
        "设备只在签名、设备身份、nonce、时间窗、次数全部验证通过后进入工作状态；必须先持久化 WORKING，再启动输出并回传 status=2。任何不确定状态都禁止盲目重发 auth。",
        "danger",
    ))
    story.append(PageBreak())


def add_reading_guide(story):
    story.append(h1("阅读导航：先确认边界，再开始编码"))
    story.append(p(
        "这不是产品宣传稿，也不包含待选方案。外部开发应先提交第 1 节列出的参数，"
        "再按角色阅读对应章节；正文中的字段、顺序、状态、错误码和验收项均按 V1.0 执行。"
    ))
    story.append(h2("按角色阅读"))
    story.append(table(
        ["角色", "优先章节", "交付重点"],
        [
            ["设备固件", "1–3、6–14、19–20、附录 A", "身份烧录、GATT、HMAC、状态机、断电恢复与错误码"],
            ["小程序", "1–8、13、15–20", "扫码细分、BLE 阶段、超时恢复、错误卡片与本机幂等"],
            ["云函数/安全", "1–3、8–13、18、20", "授权签发、共享 Key、时效与幂等确认"],
            ["QA/验收", "4–6、12–17、19–20", "按错误码和测试编号逐项留存 iOS/Android 真机证据"],
        ],
        widths=[30, 48, 92],
        font_size=7.2,
    ))
    story.append(h2("文档标记怎么理解"))
    story.append(table(
        ["标记", "含义", "开发动作"],
        [
            ["V1.0 必须", "本次交付采用的唯一协议", "必须实现，不得自行改字段或顺序"],
            ["接入参数", "必须由设备厂商提供的实际数值", "没有书面结果不得开始联调"],
            ["红色提示", "可能造成误启动、重复扣次或安全降级", "视为阻断项"],
        ],
        widths=[39, 69, 62],
        font_size=7.2,
    ))
    story.append(h2("开始开发前的四份书面结果"))
    story += bullets([
        "GATT Service / Write / Notify UUID、属性与最大可用 MTU 记录。",
        "设备可信时间来源、允许误差及 RTC 异常时的安全拒绝规则。",
        "Key 注入方式、字节解释、批次范围、读保护和泄露处置负责人。",
        "iOS/Android 真机型号、固件版本、App 版本和第 19 节测试责任人。",
    ], compact=False)
    story.append(callout(
        "放行原则",
        "任何参与方如果无法解释 canonical 字段顺序、Key 为什么不能 hex decode、授权过期如何处理、status=2 后网络中断如何恢复，就还不具备联调放行条件。",
        "warn",
    ))
    story.append(PageBreak())


def add_scope(story):
    story.append(h1("1. 范围、术语与版本边界"))
    story.append(p("本文描述从小程序扫描设备二维码开始，到设备确认进入工作状态、云函数完成一次核销为止的完整通信契约。设备厂商、小程序、云函数和测试人员均按本文件 V1.0 实现，不得自行增加另一套方案。"))
    story.append(callout(
        "版本名称不要混淆",
        "本文件版本是 V1.0；线上报文的 ver 字段当前也固定为字符串 1.0。旧小程序个别错误文案曾写“固件协议 V2.0”，那只是待修正文案，不是线协议版本。设备实现一律以本文件报文和 ver=1.0 为准。",
        "warn",
    ))
    story.append(h2("1.1 V1.0 必须实现"))
    story += bullets([
        "二维码：nc://bind?sn=<device_id>&code=<6 位数字>。",
        "BLE 广播名、device_id、device_type 三重一致性校验。",
        "唯一可识别的业务 GATT 通道：至少一个 write/writeNoResponse 与一个 notify/indicate。",
        "get_info → info、auth → auth_result、query_status → status。",
        "HMAC-SHA256 授权签名；32 hex nonce 防重放；授权有效期不超过 30 秒。",
        "设备 status=2 才允许服务端生成核销工单；同一业务请求幂等恢复。",
    ], compact=False)
    story.append(h2("1.2 术语"))
    story.append(table(
        ["术语", "说明"],
        [
            ["qualification", "人脸通过后生成的 90 秒设备办理资格；尚未扣次。"],
            ["authorization", "服务端对一台设备、一个 nonce、一次 usage_count 签发的一次性开机授权。"],
            ["nonce", "设备生成的 16 随机字节，以 32 位十六进制文本返回；只能使用一次。"],
            ["canonical string", "参与 HMAC 的严格字段拼接字符串；字段顺序、大小写、字符必须完全一致。"],
            ["status=1", "设备 READY/待机，可接受新授权。"],
            ["status=2", "设备 WORKING/已进入工作状态；可触发服务端核销。"],
        ],
        widths=[42, 128],
    ))
    story.append(h2("1.3 开始开发前必须提交的参数"))
    story.append(table(
        ["事项", "V1.0 规则", "必须提交/通过"],
        [
            ["GATT 参数", "小程序按唯一 write+notify service 自动发现", "实际 Service/Write/Notify UUID、属性与 MTU"],
            ["完整 auth 帧", "小程序一次写入完整 JSON，不主动分片", "至少两款 iPhone、两款 Android 全部写入成功"],
            ["设备可信时间", "设备按可信 now 校验 30 秒授权窗口", "时间来源、±5 秒容差及异常拒绝测试"],
        ],
        widths=[34, 73, 63],
        font_size=6.8,
    ))
    story.append(PageBreak())


def add_architecture(story):
    story.append(h1("2. 通信参与方与完整时序"))
    story.append(table(
        ["参与方", "职责", "不得承担"],
        [
            ["小程序", "扫码、BLE 连接、转发命令、展示状态、保存本机恢复进度", "不得持有 HMAC Key；不得自行计算正式授权签名；不得直接扣次"],
            ["faceRecognition v114", "校验资格和设备身份、生成签名、保存一次性授权、确认回执、幂等核销", "不得信任仅来自小程序的设备身份声明"],
            ["BLE 设备", "生成 nonce、验证签名与状态、原子进入 WORKING、持久化并回传状态", "不得把二维码 6 位 code 当成安全密钥；不得在验签前启动"],
        ],
        widths=[32, 77, 61],
    ))
    story.append(h2("2.1 正常时序"))
    normal_flow = [
        ["1", "云函数 → 小程序", "qualificationToken、expectedDeviceType、unitCount、validSeconds≤90"],
        ["2", "小程序", "扫码并严格解析 sn/code；打开蓝牙"],
        ["3", "小程序 → 设备", "按期望广播名发现并连接；订阅 notify"],
        ["4", "小程序 → 设备", "get_info（seq=1）"],
        ["5", "设备 → 小程序", "info：device_id/type/name/status/nonce"],
        ["6", "小程序 → 云函数", "qualificationToken + qrSn/qrCode + deviceInfo"],
        ["7", "云函数 → 小程序", "authorizationToken + 已签名 authCommand"],
        ["8", "小程序 → 设备", "auth（seq=2）"],
        ["9", "设备", "验签、验 nonce/时效/状态；持久化 WORKING；启动"],
        ["10", "设备 → 小程序", "auth_result：ok=true,status=2"],
        ["11", "小程序 → 云函数", "authorizationToken + deviceResult"],
        ["12", "云函数 → 小程序", "同一 verificationId/code；完成或恢复同一工单"],
    ]
    story.append(table(["序号", "方向", "数据/动作"], normal_flow, widths=[13, 42, 115]))
    story.append(callout(
        "扣次边界",
        "扫码成功、连上蓝牙、读取 info、甚至签发 authorization 都不等于已扣次。只有设备明确进入 status=2，且云函数核对 authorization 后，才执行既有原子核销。",
        "ok",
    ))
    story.append(h2("2.2 小程序阶段名（联调日志应原样保留）"))
    story.append(table(
        ["stage", "动作", "是否已进入不可盲重试区"],
        [
            ["QR_SCANNING", "扫描并解析设备二维码", "否"],
            ["ADAPTER_OPENING", "打开手机蓝牙适配器", "否"],
            ["DEVICE_DISCOVERING", "按广播名发现目标设备", "否"],
            ["DEVICE_CONNECTING", "建立 BLE 连接", "否"],
            ["PROTOCOL_DISCOVERING", "选择唯一业务 GATT 通道并订阅通知", "否"],
            ["DEVICE_READING", "发送 get_info 并校验实时身份/nonce", "否"],
            ["SERVER_AUTHORIZING", "云函数签发一次性 authorization", "是：同一资格不得再签第二份"],
            ["DEVICE_AUTHORIZING", "auth 已发送，等待 auth_result/status", "是：不得换设备或盲目重发"],
            ["FINALIZING", "设备 status=2，云函数幂等生成工单", "是：只能恢复同一工单"],
        ],
        widths=[47, 69, 54],
        font_size=6.8,
    ))
    story.append(PageBreak())


def add_identity_and_qr(story):
    story.append(h1("3. 设备身份、二维码与广播名"))
    story.append(h2("3.1 魔法柔肤身份格式（当前强制）"))
    story.append(table(
        ["字段", "格式", "示例", "校验"],
        [
            ["device_id / sn", "LA + 12 位大写 0-9/A-F", "LAF82E0CC8C5B9", "正则 ^LA[0-9A-F]{12}$"],
            ["device_type", "固定字符串", "LASER-BLE", "忽略大小写比较；签名使用服务端规范值"],
            ["ble_name", "LA- + device_id 末 6 位", "LA-C8C5B9", "区分大小写精确匹配"],
            ["session code", "6 位十进制数字", "382451", "正则 ^\\d{6}$；不是密钥"],
        ],
        widths=[35, 49, 43, 43],
    ))
    story.append(h2("3.2 正式二维码"))
    story.append(code("nc://bind?sn=LAF82E0CC8C5B9&code=382451"))
    story += bullets([
        "协议名 nc、路径 bind、参数名 sn/code；参数顺序固定为 sn 在前、code 在后。",
        "二维码不得包含 BLE_AUTH_SIGNING_KEY、签名、authorizationToken、用户信息或数据库主键。",
        "当前服务端只校验 6 位 code 的结构并保存其 SHA-256 摘要，不与设备登记表比对；它不是设备认证凭据，安全性来自实时设备身份、nonce 与 HMAC 授权。",
        "当前兼容纯文本：<SN><空格/逗号/分号/竖线><6 位 code>；新设备只印正式 nc://bind 形式。",
        "打印后必须抽检：肉眼标签、二维码 sn、固件 device_id、广播名四者一致。",
    ])
    story.append(h2("3.3 扫码解析顺序"))
    story.append(table(
        ["顺序", "处理", "失败时"],
        [
            ["1", "trim；把 &amp; 还原为 &", "空内容 → QR_EMPTY"],
            ["2", "识别 nc://bind? 查询串", "协议/路径不符 → QR_SCHEME/PATH"],
            ["3", "逐项 percent decode；参数名转小写", "编码非法 → QR_DECODE_FAILED"],
            ["4", "提取唯一 sn、code", "缺失/重复/多余安全参数 → 对应错误"],
            ["5", "sn 转大写并按 LA 格式校验", "长度/前缀/字符错误 → 分类型提示"],
            ["6", "code 必须恰好 6 位数字", "长度/非数字 → 分类型提示"],
        ],
        widths=[15, 92, 63],
    ))
    story.append(PageBreak())


def add_qr_errors(story):
    story.append(h1("4. 扫码错误提示规范"))
    story.append(callout(
        "实现要求",
        "新版小程序必须按下表拆分扫码错误，不得把所有格式问题合并为 BLE_QR_INVALID。提示必须让现场人员明确执行重扫、开放权限、更换标签或联系设备方中的一种动作。",
        "info",
    ))
    qr_errors = [
        ["BLE_QR_CANCELLED", "已取消扫码", "如仍在 90 秒内，可重新打开扫码。", "是"],
        ["BLE_QR_SCAN_FAILED", "扫码功能不可用", "检查微信相机权限、摄像头占用和系统限制。", "是"],
        ["BLE_QR_CAMERA_DENIED", "未允许使用相机", "到系统设置允许微信使用相机。", "是"],
        ["BLE_QR_EMPTY", "二维码内容为空", "清洁标签并重新对焦；仍为空请更换标签。", "是"],
        ["BLE_QR_TOO_LONG", "二维码内容异常", "内容超过协议上限，禁止处理；联系设备技术人员。", "否"],
        ["BLE_QR_SCHEME_INVALID", "不是设备二维码", "请扫描以 nc://bind 开头的设备机身二维码。", "是"],
        ["BLE_QR_PATH_INVALID", "二维码用途不正确", "当前二维码不是 bind 设备绑定码。", "是"],
        ["BLE_QR_QUERY_MISSING", "二维码参数缺失", "二维码没有设备编号和校验码，请更换标签。", "否"],
        ["BLE_QR_DECODE_FAILED", "二维码编码损坏", "参数无法解码，请重新生成并打印二维码。", "否"],
        ["BLE_QR_SN_MISSING", "缺少设备编号", "二维码必须包含 sn 参数。", "否"],
        ["BLE_QR_CODE_MISSING", "缺少设备校验码", "二维码必须包含 code 参数。", "否"],
        ["BLE_QR_DUPLICATE_SN", "设备编号重复", "二维码含多个 sn，已拒绝以防替换攻击。", "否"],
        ["BLE_QR_DUPLICATE_CODE", "设备校验码重复", "二维码含多个 code，已拒绝。", "否"],
        ["BLE_QR_SN_PREFIX_INVALID", "设备系列不匹配", "魔法柔肤设备编号必须以 LA 开头。", "换正确设备"],
        ["BLE_QR_SN_LENGTH_INVALID", "设备编号长度不正确", "LA 后必须是 12 位十六进制字符。", "否"],
        ["BLE_QR_SN_CHAR_INVALID", "设备编号含非法字符", "只允许数字 0-9 与字母 A-F。", "否"],
        ["BLE_QR_CODE_LENGTH_INVALID", "设备校验码长度不正确", "校验码必须恰好 6 位。", "否"],
        ["BLE_QR_CODE_CHAR_INVALID", "设备校验码格式不正确", "校验码只能包含数字。", "否"],
        ["BLE_QR_UNSUPPORTED_PARAM", "二维码包含不支持参数", "不处理来源不明的扩展参数；联系开发确认协议版本。", "否"],
        ["BLE_QR_PRODUCT_CODE", "扫错二维码", "请扫描设备机身码，不要扫描产品、客户或付款二维码。", "是"],
        ["BLE_QR_EXPIRED_LABEL", "设备标签已作废", "停止使用旧标签，联系设备管理员更换。", "否"],
        ["BLE_QR_NOT_LASER_DEVICE", "不是魔法柔肤设备", "本项目只能连接 LA / LASER-BLE 设备。", "换正确设备"],
    ]
    story.append(table(["错误码", "标题", "现场提示", "可重试"], qr_errors[:11],
                       widths=[45, 36, 72, 17], font_size=7.0))
    story.append(PageBreak())
    story.append(h1("4. 扫码错误提示规范（续）"))
    story.append(table(["错误码", "标题", "现场提示", "可重试"], qr_errors[11:],
                       widths=[45, 36, 72, 17], font_size=7.0))
    story.append(h2("4.1 提示文案必须回答四件事"))
    story += bullets([
        "发生在哪里：扫码、发现、连接、读状态、授权、回执还是工单确认。",
        "设备是否已经启动：未确认时不得直接说‘没有启动’，应提示先核对。",
        "本次是否扣次：status=2 且服务端完成前，不得宣称已扣次。",
        "下一步做什么：重扫、开权限、靠近设备、换正确设备、等待恢复或联系技术人员。",
    ])
    story.append(PageBreak())


def add_ble_environment(story):
    story.append(h1("5. 手机蓝牙环境、发现与连接"))
    story.append(h2("5.1 开启适配器"))
    story.append(table(
        ["条件", "小程序动作", "提示"],
        [
            ["wx.openBluetoothAdapter 不存在", "停止", "微信版本不支持，请升级微信和系统"],
            ["10001 / not available", "停止", "手机蓝牙未开启，请先打开系统蓝牙"],
            ["10000 / not init", "关闭微信后重开", "蓝牙初始化失败"],
            ["权限/定位受限", "停止并引导设置", "允许微信使用蓝牙；部分 Android 还需定位/附近设备权限"],
            ["成功", "开始高功率发现", "allowDuplicatesKey=false，powerLevel=high"],
        ],
        widths=[52, 55, 63],
    ))
    story.append(h2("5.2 发现设备"))
    story += bullets([
        "根据二维码 sn 计算 expectedBleName；示例 LAF82E0CC8C5B9 → LA-C8C5B9。",
        "比较 device.name 或 localName；当前要求精确等于 expectedBleName。",
        "设备处于 READY 时必须发送可连接广播；完整本地名称应放在 Advertising Data 或 Scan Response 中，不能只写入未广播的 GAP Device Name。",
        "广播名不得带尾随空格、不可见字符或额外批次后缀；固件日志与验收截图应记录手机实际发现到的名称。",
        "当前小程序不依赖广播中的 Service UUID，也不会主动发起系统配对；如特征权限要求加密/绑定，必须先完成 iOS/Android 真机兼容验证。",
        "15 秒内未发现即结束扫描并提示靠近、通电、解除其他手机占用。",
        "发现成功立即停止扫描，避免功耗与广播列表变化影响连接。",
        "不要仅按信号强度选择设备；近距离可能同时出现多台同系列设备。",
    ])
    story.append(h2("5.3 连接"))
    story += bullets([
        "使用微信返回的 deviceId 建连；连接超时 12 秒。deviceId 是手机平台临时标识，不等于业务 device_id。",
        "连接失败常见原因：距离远、设备已被其他手机连接、设备重启、系统蓝牙缓存、固件连接数已满。",
        "退出或结束必须取消发现、解绑通知监听、关闭连接和适配器。",
    ])
    story.append(callout(
        "iOS 与 Android 差异",
        "不要持久化并跨设备复用微信 deviceId；每次办理都应通过广播名重新发现。Android 需覆盖定位/附近设备授权差异，iOS 需覆盖首次系统蓝牙授权弹窗。",
        "info",
    ))
    story.append(PageBreak())


def add_gatt(story):
    story.append(h1("6. GATT 通道发现与字节传输"))
    story.append(h2("6.1 本项目使用的统一通道"))
    story.append(p(
        "设备建立 BLE 连接后，小程序仍需要找到负责业务通信的 service 和 characteristics。"
        "可以把 Service UUID 理解为业务通信的“房间号”，Write UUID 是小程序向设备发送 get_info、auth、query_status 的“写入窗口”，"
        "Notify/Indicate UUID 是设备返回身份、开机结果和状态的“通知窗口”。UUID 是通道标识，不是设备编号，也不是密钥。"
    ))
    story.append(callout(
        "本项目采用简单结构",
        "设备只需一个统一业务 Service、一个 Write Characteristic 和一个 Notify/Indicate Characteristic。身份读取、开机授权、状态查询和必要诊断均共用这一组通道，通过 JSON 中的 cmd 区分。无需为了不同功能额外创建多组 service。",
        "info",
    ))
    story.append(table(
        ["参数", "作用", "V1.0 要求"],
        [
            ["Service UUID", "定位统一业务通信服务", "设备提供实际值；只允许一个业务候选"],
            ["Write Characteristic UUID", "发送 get_info / auth / query_status", "只允许一个；属性为 write 或 writeNoResponse"],
            ["Notify/Indicate UUID", "返回 info / auth_result / status", "只允许一个；属性为 notify 或 indicate"],
            ["最大可用 MTU", "决定一次写入可承载的字节数", "设备提供实际值；完整 auth 帧必须真机通过"],
        ],
        widths=[42, 63, 65],
    ))
    story.append(callout(
        "设备厂家交付参数",
        "提交一个 Service UUID、一个 Write Characteristic UUID、一个 Notify/Indicate Characteristic UUID，并注明特征属性、是否需要配对或加密、最大 MTU。全部业务指令共用这组通道并以 cmd 区分；验收后不得因设备批次自行改变。",
        "info",
    ))
    story.append(h2("6.2 当前通道选择算法"))
    story += bullets([
        "枚举所有 primary service。",
        "每个 service 枚举 characteristics。",
        "候选 service 必须同时具有至少一个 write/writeNoResponse 与至少一个 notify/indicate characteristic。",
        "候选为 0：BLE_PROTOCOL_CHANNEL_MISSING；候选大于 1：BLE_PROTOCOL_CHANNEL_AMBIGUOUS。",
        "候选恰好 1：优先选择 write 与 notify，否则使用 writeNoResponse / indicate。",
        "先订阅 notify/indicate，再发送 get_info，避免错过快速回执。",
    ])
    story.append(callout(
        "固件要求",
        "当前小程序没有写死 UUID，因此设备必须只暴露一个满足上述条件的业务 service；该 service 中必须只有一个业务 write 与一个业务 notify characteristic。其他 service 不得同时呈现可写+可通知组合。",
        "danger",
    ))
    story += bullets([
        "V1.0 不规定固定 UUID。设备方须在联调记录中提供实际 Service UUID、Write UUID、Notify UUID 和属性截图，便于问题定位。",
        "广播包的 localName/name 必须能被微信发现为 LA-末 6 位；Service UUID 是否放入广播不作为当前筛选条件。",
    ])
    story.append(h2("6.3 帧格式"))
    story.append(code("UTF-8(JSON.stringify(payload)) + 0x0A"))
    story.append(table(
        ["规则", "要求"],
        [
            ["编码", "UTF-8；字段名使用 ASCII；文本不得使用本地编码"],
            ["帧边界", "LF（\\n，0x0A）；CRLF 可由接收端 trim 兼容，但发送统一 LF"],
            ["分片", "接收方必须缓存，直到出现 LF 才解析；半帧不得报 JSON 错误"],
            ["粘包", "一次通知可能含多帧；按 LF 循环逐帧解析"],
            ["空行", "忽略"],
            ["非法 JSON", "记录协议警告并等待下一条有效帧；不得启动设备"],
            ["长度", "auth 可能超过默认 ATT 单包；固件与小程序必须在 iOS/Android 真机验证长帧策略"],
        ],
        widths=[35, 135],
    ))
    story.append(PageBreak())
    story.append(h2("6.4 长帧风险"))
    story += bullets([
        "当前小程序一次调用 writeBLECharacteristicValue 写完整 JSON 帧；设备厂商必须验证目标微信版本与固件 MTU 行为。",
        "若实机出现截断，不得私自改变 JSON 或签名字段；应在小程序 transport 层增加确定性的分片发送，并在设备侧重组到 LF。",
        "小程序接收缓存上限为 2048 字节；连续 5 秒没有新字节时必须丢弃未完成帧并返回协议超时。设备不得发送超过上限或长期不结束的帧。",
    ])
    story.append(callout(
        "P0 真机门槛",
        "在至少两款 iPhone、两款 Android 上实测完整 auth 帧。只要任一机型出现 write 失败或设备收到截断帧，就必须先给小程序补发送分片与节流，再做量产验收；不能把‘模拟器能写’当作 BLE 真机通过。",
        "warn",
    ))


def add_commands(story):
    story.append(h1("7. get_info / info：读取设备真实状态"))
    story.append(h2("7.1 小程序请求"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"get_info","ts":1735689600}\n'))
    story.append(h2("7.2 设备成功回执"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"info","ok":true,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","ble_name":"LA-C8C5B9","status":1,"nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(table(
        ["字段", "类型/格式", "必填", "说明"],
        [
            ["ver", "string = 1.0", "是", "协议版本；未知大版本应拒绝"],
            ["seq", "integer = 1", "是", "必须对应请求；小程序只接受 seq=1"],
            ["cmd", "info 或 get_info_result", "是", "当前小程序兼容两个名称；新固件统一 info"],
            ["ok", "boolean", "是", "false 时同时返回 code/message"],
            ["device_id", "LA + 12 hex", "是", "固件安全配置中的永久设备编号"],
            ["device_type", "LASER-BLE", "是", "必须与当前项目 expectedDeviceType 一致"],
            ["ble_name", "LA-末 6 位", "是", "必须与二维码推导值一致"],
            ["status", "0/1/2", "是", "0 非就绪；1 READY；2 WORKING"],
            ["nonce", "32 hex", "是", "16 字节 CSPRNG；当前会话唯一；小写/大写均可输入"],
        ],
        widths=[32, 48, 18, 72],
    ))
    story.append(h2("7.3 小程序强制校验"))
    story += bullets([
        "info.device_id 必须等于二维码 sn。",
        "LA 设备只允许 expectedDeviceType=LASER-BLE；LASER-BLE 也只允许 LA 设备。",
        "device_type 忽略大小写等于 expectedDeviceType。",
        "ble_name 必须精确等于 LA- + sn 末 6 位。",
        "status 只接受 1 或 2；新授权签发前服务端只接受 1。",
        "nonce 必须 32 位十六进制；不得用时间戳、设备号截断或固定值代替随机数。",
    ])
    story.append(PageBreak())


def add_auth(story):
    story.append(h1("8. auth / auth_result：一次性开机授权"))
    story.append(h2("8.1 云函数签发的 auth"))
    story.append(code(
        '{"ver":"1.0","seq":2,"cmd":"auth","auth":{'
        '"command":"enter_work",'
        '"device_id":"LAF82E0CC8C5B9",'
        '"device_type":"LASER-BLE",'
        '"nonce":"00112233445566778899aabbccddeeff",'
        '"usage_count":1,'
        '"issued_at":1735689600,'
        '"expire_at":1735689630,'
        '"signature":"<64 位小写 hex>"}}\n'
    ))
    story.append(table(
        ["字段", "验证要求"],
        [
            ["ver / seq / cmd", "必须分别为 1.0 / 2 / auth"],
            ["command", "必须为 enter_work"],
            ["device_id", "必须等于本机永久 ID"],
            ["device_type", "必须等于本机配置 LASER-BLE"],
            ["nonce", "必须等于当前 READY 会话 nonce，且 used=false"],
            ["usage_count", "整数 1–999，并在设备能力范围内"],
            ["issued_at", "Unix 秒；不能明显晚于设备可信时间"],
            ["expire_at", "Unix 秒；expire_at > issued_at；差值最大 30 秒；当前时间不超过 expire_at"],
            ["signature", "64 位小写 HMAC-SHA256 hex；常量时间比较"],
        ],
        widths=[42, 128],
    ))
    story.append(h2("8.2 成功回执"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("8.3 原子状态转换"))
    story += bullets([
        "校验全部字段和签名；任何失败返回错误且保持 status=1。",
        "在非易失存储中写入：WORKING、nonce used=true、usage_count、起始时间、剩余进度、配置快照。",
        "确认持久化成功后，才允许启动设备输出。",
        "状态切换为 2 后发送 auth_result。即使通知丢失，query_status 也必须持续返回同一会话 status=2。",
        "断电重启后恢复原 WORKING，不得生成新 nonce 覆盖未完成会话。",
    ])
    story.append(h2("8.4 可信时间要求"))
    story += bullets([
        "issued_at/expire_at 由服务端写入签名，设备不能修改；但设备仍需可信当前时间判断是否过期。",
        "get_info 请求中的 ts 来自手机且没有签名，只能用于诊断，禁止直接拿它校准安全时钟。",
        "设备必须使用 RTC + 防回退记录或受保护单调时钟；设备时间异常时返回 CLOCK_INVALID，不得降级成永久接受。",
        "允许的时钟偏差固定为 ±5 秒，且不得放宽 30 秒授权总窗口。",
    ])
    story.append(PageBreak())


def add_key(story):
    story.append(h1("9. Key 详解：BLE_AUTH_SIGNING_KEY"))
    story.append(callout(
        "它是什么",
        "这是云函数与设备共享的 HMAC-SHA256 对称认证密钥，用于证明 enter_work 指令由可信服务端签发，并防止指令被篡改。它不是二维码 code、不是 authorizationToken、不是 RSA 公钥，也不提供内容加密。",
        "info",
    ))
    story.append(h2("9.1 存放位置"))
    story.append(table(
        ["位置", "允许", "禁止"],
        [
            ["云函数", "环境变量 BLE_AUTH_SIGNING_KEY；仅运行时读取", "源码、README、日志、响应、数据库"],
            ["设备", "受保护的安全存储/受控烧录区；启用读保护", "普通 Flash 明文区、调试菜单、BLE 读取接口、串口日志"],
            ["小程序", "完全不持有；只转发服务端生成的 authCommand", "打包资源、storage、网络日志、埋点"],
            ["二维码", "不包含 Key", "任何密钥、签名或长期凭据"],
        ],
        widths=[28, 78, 64],
    ))
    story.append(h2("9.2 当前最容易写错的字节解释"))
    story.append(callout(
        "当前生产约定",
        "当前 Key 采用 64 个小写十六进制字符保存，但云函数会先去掉首尾空白，再把这 64 个字符本身按 UTF-8/ASCII 字节参与 HMAC。设备必须保存同样的无空白 64 字节文本；不要把它 hex decode 成 32 个原始字节。两种做法得到的签名完全不同。",
        "danger",
    ))
    story.append(code(
        "正确：HMAC key bytes = UTF8(\"0123...abcd\")  # 64 个文本字符 → 64 bytes\n"
        "错误：HMAC key bytes = HEX_DECODE(\"0123...abcd\")  # 64 hex → 32 bytes"
    ))
    story.append(h2("9.3 Key 最低要求与注入"))
    story += bullets([
        "云函数要求 UTF-8 字节长度至少 32；正式环境 Key 必须由 CSPRNG 生成 32 字节后编码为 64 位小写 hex 文本。",
        "生产 Key 不得通过普通小程序 BLE 通道写入。使用离线/受控工装，在设备出厂阶段注入。",
        "烧录完成后用公开测试向量校验算法，再用受控生产验收工具校验同批设备；验收记录只保存设备批次，不保存 Key。",
        "禁止将生产 Key 发到微信群、工单截图、邮件正文或测试报告。开发联调应使用独立测试 Key。",
    ])
    story.append(callout(
        "共享 Key 的固定规则",
        "V1.0 全部设备使用同一个 BLE_AUTH_SIGNING_KEY，不使用 key_id，也不采用按批次或每设备 Key。所有设备必须启用芯片读保护，任何接口和日志均不得读出生产 Key。",
        "warn",
    ))
    story.append(PageBreak())


def add_signature(story):
    demo_key = "0123456789abcdef" * 4
    canonical = (
        "command=enter_work&device_id=LAF82E0CC8C5B9&device_type=LASER-BLE"
        "&usage_count=1&expire_at=1735689630&issued_at=1735689600"
        "&nonce=00112233445566778899aabbccddeeff"
    )
    signature = hmac.new(demo_key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    wrong_signature = hmac.new(bytes.fromhex(demo_key), canonical.encode("utf-8"), hashlib.sha256).hexdigest()

    story.append(h1("10. 签名 canonical string 与测试向量"))
    story.append(h2("10.1 字段顺序（不能排序、不能调整）"))
    story.append(code(
        "command=<...>&device_id=<...>&device_type=<...>&usage_count=<...>"
        "&expire_at=<...>&issued_at=<...>&nonce=<...>"
    ))
    story += bullets([
        "字段名全小写且固定；没有空格、引号、换行或 URL 编码。",
        "usage_count、expire_at、issued_at 使用十进制文本；不得带小数、前导 +、科学计数法。",
        "device_id 使用大写规范值；device_type 使用服务端返回的规范值 LASER-BLE。",
        "nonce 必须由设备统一输出小写 hex，签名时保持收到的文本值。",
        "最终 signature 输出 64 位小写 hex。",
    ])
    story.append(h2("10.2 非生产测试向量"))
    story.append(code(canonical))
    story.append(table(
        ["项目", "值"],
        [
            ["demo key", demo_key],
            ["key bytes", "对 demo key 做 UTF-8：64 bytes（不得 hex decode）"],
            ["expected HMAC", signature],
            ["错误示例（hex decode key）", wrong_signature],
        ],
        widths=[39, 131],
        font_size=6.8,
    ))
    story.append(callout(
        "联调门槛",
        "设备固件必须先离线通过该测试向量，再接真机 BLE。若 expected HMAC 不一致，优先检查 Key 的 UTF-8/hex 解释、字段顺序、数字格式和末尾是否误加换行。",
        "ok",
    ))
    story.append(h2("10.3 与云函数完全一致的 Node.js 复现"))
    story.append(code(
        "const crypto = require('crypto');\n"
        "const signature = crypto.createHmac('sha256', Buffer.from(KEY_TEXT.trim(), 'utf8'))\n"
        "  .update(CANONICAL, 'utf8').digest('hex');"
    ))
    story.append(h2("10.4 设备验签伪代码"))
    story.append(code(
        "assert cmd == 'auth' and seq == 2\n"
        "assert auth.command == 'enter_work'\n"
        "assert auth.device_id == LOCAL_DEVICE_ID\n"
        "assert auth.device_type == LOCAL_DEVICE_TYPE\n"
        "assert auth.nonce == current_nonce and nonce_used == false\n"
        "assert 1 <= usage_count <= 999\n"
        "assert issued_at < expire_at and expire_at - issued_at <= 30\n"
        "assert trusted_now <= expire_at\n"
        "expected = HMAC_SHA256_UTF8(KEY_TEXT, CANONICAL_UTF8)\n"
        "assert constant_time_equal(lower_hex(expected), signature)"
    ))
    story.append(PageBreak())


def add_key_lifecycle(story):
    story.append(h1("11. Key 生命周期、轮换与泄露处置"))
    story.append(h2("11.1 当前规则"))
    story.append(p("faceRecognition v114 和全部设备只使用同一个 BLE_AUTH_SIGNING_KEY。云端或设备端任何一方单独换 Key，都会让全部授权报 1001 INVALID_SIGNATURE。"))
    story.append(h2("11.2 当前可执行轮换方案"))
    story.append(table(
        ["阶段", "操作", "风险控制"],
        [
            ["准备", "生成新 Key；建立设备批次清单；测试环境完成测试向量和真机验收", "旧/新 Key 严格分离；不在生产试错"],
            ["协调窗口", "暂停相关设备办理；更新设备安全存储与云函数环境变量", "必须同一窗口完成；禁止只改一端"],
            ["验证", "每个批次执行 get_info/auth/status=2 的受控测试", "确认无 1001；检查日志不含 Key"],
            ["恢复", "恢复业务；观察签名失败率", "保留回滚计划，但不得让旧 Key 长期暴露"],
        ],
        widths=[28, 84, 58],
    ))
    story.append(h2("11.3 怀疑 Key 泄露时"))
    story += bullets([
        "立即暂停设备开机授权，不要只删除聊天记录或修改二维码。",
        "确认泄露范围：生产/测试、具体批次、是否可伪造 auth。",
        "生成新 Key 并按受控窗口轮换；旧 Key 作废。",
        "排查云函数日志、设备串口、崩溃报告、安装包和代码仓库是否包含 Key。",
        "核对异常时段的 nonce、设备 ID、签名失败/成功和核销记录；保留审计证据。",
    ])
    story.append(PageBreak())


def add_state_machine(story):
    story.append(h1("12. 设备状态机与防重放"))
    story.append(table(
        ["状态", "status", "允许命令", "关键行为"],
        [
            ["NOT_READY", "0", "get_info/query_status", "未复位、故障或未完成配置；拒绝 auth"],
            ["READY", "1", "get_info/auth/query_status", "持有当前 nonce，nonce_used=false"],
            ["WORKING", "2", "get_info/query_status", "拒绝新 auth；持续返回原会话身份、nonce、usage_count"],
            ["COMPLETED/ENDED", "设备内部", "本地收尾", "安全停止，保存结果，再生成新 nonce 并进入 READY"],
            ["FAULT", "0", "诊断", "安全停机；返回明确错误；不得猜测恢复输出"],
        ],
        widths=[39, 18, 50, 63],
    ))
    story.append(h2("12.1 nonce 规则"))
    story += bullets([
        "使用密码学安全随机数生成器生成 16 bytes，输出 32 hex；禁止使用 rand()、时间戳、MAC 地址或设备号拼接。",
        "每次新 READY 会话生成新 nonce；同一 WORKING 会话断电恢复时保留原 nonce。",
        "成功接受 auth 前后必须原子持久化 nonce used 标志；旧 nonce 永远不能再次启动。",
        "云端数据库对已签发 nonce 做唯一约束；设备本地也必须独立防重放。",
    ])
    story.append(h2("12.2 断电安全写入顺序"))
    story.append(code(
        "validate auth → write pending session → fsync/commit → mark nonce used → "
        "mark WORKING → start output → send auth_result"
    ))
    story.append(callout(
        "禁止的顺序",
        "先启动设备、再保存 WORKING 会造成断电后无法判断是否已经使用授权；先回 success、再持久化会造成小程序扣次而设备状态丢失。",
        "danger",
    ))
    story.append(PageBreak())


def add_status_recovery(story):
    story.append(h1("13. query_status、超时与恢复"))
    story.append(h2("13.1 查询请求/回执"))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"query_status"}\n'))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"status","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("13.2 当前超时参数"))
    story.append(table(
        ["环节", "超时", "超时后"],
        [
            ["发现设备", "15 秒", "停止扫描；允许在资格有效期内重试"],
            ["建立连接", "12 秒", "关闭连接；提示解除其他手机占用"],
            ["等待 info", "10 秒", "关闭连接；未签授权，可重连重读"],
            ["等待 auth_result", "20 秒", "不立刻判失败；自动发送 query_status"],
            ["等待 status", "5 秒", "结果不确定；禁止盲目重发 auth"],
            ["qualification", "最多 90 秒", "未签 auth：清理后重新人脸；已签 auth：进入恢复锁定"],
            ["authorization", "最多 30 秒且不超过 qualification 剩余", "过期后不能重复发送；核对设备实际状态"],
        ],
        widths=[47, 26, 97],
    ))
    story.append(h2("13.3 恢复矩阵"))
    recovery_rows = [
        ["未扫码/未签 auth", "关闭或超时", "资格期内重开；到期后重做人脸", "可以，未扣次"],
        ["已连接/未签 auth", "断线", "重新发现并读取设备", "可以，未扣次"],
        ["auth 已签发/未发送", "App 中断", "只恢复原资格、原设备；禁止签第二份", "不允许换设备"],
        ["auth 已发送/无回执", "结果未知", "query_status；只认 status=2", "禁止重发 auth"],
        ["设备 status=2/云端未确认", "网络中断", "本机保存回执；重试 confirm；恢复同一工单", "不得重新扣次"],
        ["工单已生成", "页面跳转失败", "按 clientRequestId/authorization 恢复同一工单", "禁止再次扫码"],
        ["工作中断电", "设备重启", "恢复 WORKING，status=2，继续原会话", "不生成新 nonce"],
    ]
    story.append(table(["发生点", "现象", "正确动作", "禁止/结果"], recovery_rows,
                       widths=[44, 32, 63, 31], font_size=6.8))
    story.append(h2("13.4 本机恢复记录"))
    story.append(p("小程序按登录 UID 保存 lusizhuoerMiniBleVerificationV1:<uid>。它只用于防重复和恢复，不是服务端信任根；换手机、换微信或清缓存后，服务端仍按 authorization 与数据库状态判定。"))
    story.append(table(
        ["阶段", "至少保存"],
        [
            ["QUALIFIED", "clientRequestId、qualificationToken、qualificationExpiresAt、qualification"],
            ["AUTHORIZATION_ISSUED", "再保存 authorizationToken、deviceId、deviceType、nonce"],
            ["DEVICE_WORKING", "再保存 deviceResult、irreversible=true"],
            ["FINALIZED", "再保存 verificationId、verificationCode；随后按权威工单清理本机进度"],
        ],
        widths=[46, 124],
        font_size=6.9,
    ))
    story.append(callout(
        "首个确认的时效边界",
        "当前 v114 在 authorization 仍为 ISSUED 且 expire_at 已过时，会拒绝第一次 confirm，即使设备现场已经工作。因此设备进入 status=2 后必须立即回执，小程序必须马上 confirm；网络中断测试必须覆盖这个窗口。",
        "warn",
    ))
    story.append(PageBreak())


def add_device_errors(story):
    story.append(h1("14. 设备必须返回的错误码"))
    current_errors = [
        ["400", "BAD_REQUEST", "JSON、字段或类型无法识别", "修正帧；status 不变"],
        ["403", "FORBIDDEN", "设备策略拒绝", "检查安全/本地策略"],
        ["404", "UNSUPPORTED_COMMAND", "不支持命令", "设备未实现 V1.0，禁止交付"],
        ["1001", "INVALID_SIGNATURE", "HMAC 不一致", "检查 Key 字节、canonical、大小写"],
        ["1002", "AUTH_EXPIRED", "授权时间窗非法或已过期", "重新人脸签发；旧 auth 不重发"],
        ["1003", "NONCE_MISMATCH", "auth nonce 不是当前 nonce", "重读 info"],
        ["1004", "NONCE_USED", "nonce 已使用", "禁止重放；查询旧会话"],
        ["1005", "DEVICE_BUSY", "设备已 WORKING", "query_status；不得再次启动"],
        ["1006", "DEVICE_ID_MISMATCH", "授权 ID 不是本机 ID", "检查标签/烧录配置"],
        ["1007", "DEVICE_TYPE_MISMATCH", "授权类型不是本机类型", "换正确项目设备"],
        ["1008", "UNSUPPORTED_OPERATION", "不支持 enter_work", "设备未实现 V1.0，禁止交付"],
        ["1009", "NOT_PROVISIONED", "Key/身份/安全配置不完整", "停止使用并返厂/配置"],
        ["1011", "INVALID_USAGE_COUNT", "次数非整数、越界或能力不支持", "核对 usage_count"],
    ]
    required_additional_errors = [
        ["1010", "CLOCK_INVALID", "设备时间不可用于授权校验", "同步可信时间或修复 RTC"],
        ["1012", "PERSIST_FAILED", "WORKING 状态持久化失败", "安全停机；不得启动"],
        ["1013", "OUTPUT_START_FAILED", "已授权但执行机构未能启动", "安全停机并保留故障状态"],
        ["1014", "FRAME_TOO_LARGE", "输入帧超过上限", "丢弃到下一个 LF"],
        ["1015", "PROTOCOL_VERSION", "协议版本不兼容", "拒绝接入，只接受 ver=1.0"],
    ]
    story.append(h2("14.1 当前小程序已识别"))
    story.append(table(["code", "符号", "含义", "设备/现场动作"], current_errors,
                       widths=[14, 43, 54, 59], font_size=6.9))
    story.append(PageBreak())
    story.append(h1("14. 设备错误码（续）"))
    story.append(h2("14.2 V1.0 状态与协议错误"))
    story.append(table(["code", "符号", "含义", "设备/现场动作"], required_additional_errors,
                       widths=[14, 43, 54, 59], font_size=7.0))
    story.append(h2("14.3 统一失败回执"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":false,"code":1001,"message":"invalid signature","status":1}\n'))
    story += bullets([
        "seq 必须关联原请求；cmd 与请求类型对应。",
        "message 只给简短诊断，不得包含 Key、完整签名、内存地址、堆栈或受保护配置。",
        "拒绝 auth 时设备保持安全状态，不能产生任何工作输出。",
        "小程序必须将 1010、1012–1015 映射为对应中文提示，不得只显示未知错误。",
    ])
    story.append(PageBreak())


def add_app_errors_one(story):
    story.append(h1("15.1 小程序错误：环境与连接"))
    story.append(h2("权限、发现和连接"))
    story.append(callout(
        "实现说明",
        "新版小程序必须实现表内全部错误码。每个错误必须包含稳定错误码、中文标题、处理办法和是否允许重试，不得落入 undefined、接口原文或通用失败。",
        "info",
    ))
    errors = [
        ["BLE_API_UNAVAILABLE", "微信版本不支持", "升级微信和手机系统", "否"],
        ["BLE_SWITCH_OFF", "手机蓝牙未开启", "打开系统蓝牙并回到微信", "是"],
        ["BLE_ADAPTER_INIT_FAILED", "蓝牙初始化失败", "完全退出微信后重开；仍失败重启手机", "是"],
        ["BLE_ADAPTER_OPEN_FAILED", "没有蓝牙权限", "系统设置允许微信使用蓝牙/附近设备", "是"],
        ["BLE_LOCATION_DENIED", "未允许附近设备定位", "Android 开启定位或附近设备权限", "是"],
        ["BLE_DEVICE_NOT_FOUND", "没有找到设备", "靠近、通电、确认广播名、解除其他手机连接", "是"],
        ["BLE_DEVICE_ID_EMPTY", "手机未返回蓝牙标识", "停止扫描后重试；不要复用旧 deviceId", "是"],
        ["BLE_CONNECTION_FAILED", "设备连接失败", "靠近设备、断开其他手机、重启设备后重试", "是"],
        ["BLE_CONNECTION_CLOSED", "蓝牙连接已断开", "未签 auth 可重连；已签 auth 只核对原设备", "条件"],
        ["BLE_PROTOCOL_CHANNEL_MISSING", "设备通信通道缺失", "固件提供同一 service 下的 write + notify", "修复后"],
        ["BLE_PROTOCOL_CHANNEL_AMBIGUOUS", "设备通信通道不唯一", "固件只保留一个业务候选 service", "修复后"],
        ["BLE_NOTIFY_ENABLE_FAILED", "无法订阅设备通知", "检查 characteristic 属性和 CCCD", "修复后"],
        ["BLE_WRITE_FAILED", "指令发送失败", "靠近设备；核对 MTU/连接/characteristic 权限", "是"],
        ["BLE_FRAME_TOO_LARGE", "设备数据帧过长", "限制帧长；检查异常固件输出", "修复后"],
        ["BLE_JSON_INVALID", "设备返回无法解析的数据", "检查 UTF-8、LF、分片与 JSON", "修复后"],
        ["BLE_INFO_TIMEOUT", "读取设备状态超时", "确认 notify 已开启、设备 READY，再重连", "是"],
        ["BLE_STATUS_TIMEOUT", "设备状态无法确认", "不要重发 auth；保留错误码并检查设备现场状态", "否"],
        ["BLE_AUTH_RESULT_TIMEOUT", "开机结果未返回", "系统先 query_status；等待恢复结果", "自动核对"],
    ]
    story.append(table(["错误码", "标题", "处理办法", "重试"], errors[:9],
                       widths=[49, 38, 66, 17], font_size=7.0))
    story.append(PageBreak())
    story.append(h1("15.2 小程序错误：协议与超时"))
    story.append(table(["错误码", "标题", "处理办法", "重试"], errors[9:],
                       widths=[49, 38, 66, 17], font_size=7.0))
    story.append(PageBreak())


def add_app_errors_two(story):
    story.append(h1("16.1 小程序错误：身份与资格"))
    story.append(h2("设备身份、办理资格和授权前校验"))
    errors = [
        ["BLE_DEVICE_ID_MISMATCH", "设备编号不一致", "二维码与蓝牙不是同一台，停止授权"],
        ["BLE_DEVICE_TYPE_MISMATCH", "设备类型不匹配", "魔法柔肤只能使用 LA / LASER-BLE"],
        ["BLE_NAME_MISMATCH", "广播名不一致", "检查烧录配置与机身标签，禁止授权"],
        ["BLE_DEVICE_NOT_READY", "设备未处于待机", "结束旧服务并复位到 status=1"],
        ["BLE_DEVICE_BUSY_OTHER_SESSION", "设备正在其他服务中", "本机无对应授权，不得接管或扣次"],
        ["BLE_NONCE_INVALID", "设备随机数无效", "修复 CSPRNG/格式；禁止授权"],
        ["BLE_NONCE_REUSED", "设备随机数已使用", "查询原会话，生成新 READY nonce"],
        ["BLE_QUALIFICATION_NOT_FOUND", "未找到 90 秒资格", "重新拍照建立资格"],
        ["BLE_QUALIFICATION_EXPIRED", "90 秒资格已过期", "未扣次；重新人脸"],
        ["BLE_QUALIFICATION_MISMATCH", "页面与服务端资格不一致", "清理本次页面并重新办理"],
        ["BLE_AUTHORIZATION_INCOMPLETE", "服务端授权不完整", "不发设备；检查云函数返回"],
        ["BLE_AUTHORIZATION_ALREADY_ISSUED", "授权已签发", "只恢复原设备，禁止签发第二份"],
        ["BLE_AUTHORIZATION_DEVICE_LOCKED", "资格已绑定原设备", "不能换设备；核对原设备状态"],
        ["BLE_AUTHORIZATION_EXPIRED", "开机授权已过期", "旧 auth 不重发；核对设备后重新办理"],
        ["BLE_SIGNING_KEY_MISSING", "云端未配置设备 Key", "管理员配置 BLE_AUTH_SIGNING_KEY"],
        ["BLE_SIGNING_KEY_INVALID", "云端 Key 长度不足", "至少 32 UTF-8 bytes；设备与云端字节一致"],
        ["BLE_DEVICE_NOT_WORKING", "设备未确认启动", "不扣次；继续核对而不是直接成功"],
        ["BLE_DEVICE_RECEIPT_MISMATCH", "设备回执与授权不一致", "锁定并人工核查 ID/type/nonce"],
        ["BLE_ALREADY_FINALIZED", "核销已经完成", "打开原工单，禁止重复扫码"],
        ["BLE_PROGRESS_SAVE_FAILED", "无法保存防重复进度", "停止继续，清理微信空间后再办"],
        ["BLE_SESSION_EXPIRED", "登录状态已失效", "重新登录并从原工单恢复"],
        ["FORBIDDEN", "当前账号无权办理", "换有该门店权限的账号"],
    ]
    story.append(table(["错误码", "标题", "处理办法"], errors[:11],
                       widths=[55, 43, 72], font_size=7.0))
    story.append(PageBreak())
    story.append(h1("16.2 小程序错误：授权与回执"))
    story.append(h2("一次性授权、设备回执和会话"))
    story.append(table(["错误码", "标题", "处理办法"], errors[11:],
                       widths=[55, 43, 72], font_size=7.0))
    story.append(callout(
        "未知错误兜底",
        "标题使用“未识别的设备错误”，正文显示安全的中文说明和错误码；不要把 Cannot read properties、SQLSTATE、undefined、堆栈或原始 Key/签名显示给业务人员。",
        "warn",
    ))
    story.append(PageBreak())


def add_error_ux(story):
    story.append(h1("17. 错误展示、日志与隐私"))
    story.append(h2("17.1 页面错误卡片字段"))
    story.append(table(
        ["字段", "示例", "要求"],
        [
            ["标题", "设备编号不一致", "8–16 字，现场人员一眼知道类别"],
            ["说明", "二维码与蓝牙设备不是同一台设备，已禁止授权。", "说明安全结果；不夸大已扣次"],
            ["下一步", "请检查机身标签，重新扫描正确设备。", "给出单一步骤或明确联系对象"],
            ["错误码", "BLE_DEVICE_ID_MISMATCH", "可复制/截图，便于技术定位"],
            ["状态", "设备未启动｜本次未扣次", "仅在系统能够确认时展示；未知则写‘正在核对’"],
            ["按钮", "重新扫码 / 返回 / 联系技术", "retryable=false 时不显示误导性的立即重试"],
        ],
        widths=[30, 72, 68],
    ))
    story.append(h2("17.2 可记录的诊断字段"))
    story += bullets([
        "时间、App 版本、微信基础库版本、iOS/Android 与系统版本。",
        "错误码、阶段、耗时、重试次数、RSSI 区间、Service/Characteristic UUID（不含数据内容）。",
        "device_id 可按权限记录或脱敏末 6 位；authorizationToken 只记录 hash/末尾片段。",
        "记录 status、seq、协议版本、固件版本、是否收到完整 LF 帧。",
    ])
    story.append(h2("17.3 永远不能记录"))
    story += bullets([
        "BLE_AUTH_SIGNING_KEY、设备安全存储内容、完整授权 signature。",
        "二维码 6 位 code 的明文长期日志、完整 qualificationToken/authorizationToken。",
        "客户人脸图片、身份证明、手机号等与设备联调无关的数据。",
        "设备内存转储、密钥区地址、可复现生产 Key 的派生材料。",
    ])
    story.append(PageBreak())


def add_backend_contract(story):
    story.append(h1("18. 小程序与云函数接口（仅设备通信所需）"))
    story.append(table(
        ["action", "请求核心字段", "返回/效果", "失败原则"],
        [
            ["createVerificationBleQualification", "clientRequestId、faceRequestId/evidence、项目、unitCount", "qualificationToken、validSeconds≤90、expectedDeviceType", "未生成设备 auth；不扣次"],
            ["recoverVerificationBleQualification", "clientRequestId", "恢复资格、授权是否已签发、是否已有工单", "结果不确定时锁定重复办理"],
            ["issueVerificationBleAuthorization", "qualificationToken、qrSn、qrCode、deviceInfo", "authorizationToken + authCommand；最长 30 秒", "同一资格只签一次；nonce 唯一"],
            ["confirmVerificationBleWorkStarted", "authorizationToken、deviceResult status=2", "核销工单；幂等返回同一结果", "ID/type/nonce 不一致即拒绝"],
        ],
        widths=[48, 52, 48, 22],
        font_size=6.5,
    ))
    story.append(h2("18.1 服务端签发前重新校验"))
    story += bullets([
        "资格属于当前账号/门店、未过期、未完成、未签过其他授权。",
        "qrSn 为支持格式、qrCode 恰好 6 位、deviceInfo 的 id/name/type/nonce/status 合法。",
        "二维码 sn = info.device_id；广播名 = 推导值；expectedDeviceType 与设备类型一致。",
        "status 必须为 1；nonce 未被使用；Key 存在且 UTF-8 长度至少 32。",
        "expire_at = min(issued_at + 30 秒, qualification 到期时间)。",
    ])
    story.append(h2("18.2 服务端确认前重新校验"))
    story += bullets([
        "authorizationToken 存在且属于当前账号/门店。",
        "deviceResult.ok=true 且 status=2。",
        "回执 device_id、device_type、nonce 与数据库授权完全一致。",
        "未过期且状态为 ISSUED/DEVICE_WORKING；已完成则恢复同一工单。",
    ])
    story.append(callout(
        "V1.0 回执校验边界",
        "V1.0 不验证设备回执 HMAC。服务端只按 BLE 会话、authorizationToken、device_id、device_type、nonce、status 和幂等状态确认回执；开发人员不得自行增加未定义字段。",
        "info",
    ))
    story.append(PageBreak())


def add_test_matrix_one(story):
    story.append(h1("19.1 联调测试：扫码、发现与传输"))
    tests = [
        ["Q01", "正式 nc://bind 二维码", "解析 sn/code；不泄露 Key"],
        ["Q02", "空码/非设备码/付款码", "分别提示 EMPTY/SCHEME/扫错二维码"],
        ["Q03", "sn 缺失、重复、长度错、含 G", "分别提示；不打开蓝牙"],
        ["Q04", "code 缺失、5 位、7 位、含字母", "分别提示；不请求授权"],
        ["Q05", "参数 percent-encoding 损坏", "DECODE_FAILED；不崩溃"],
        ["B01", "蓝牙关闭/权限拒绝", "明确引导设置；未扣次"],
        ["B02", "15 秒无目标广播", "停止扫描，DEVICE_NOT_FOUND"],
        ["B03", "同场多台设备", "只按二维码推导广播名匹配"],
        ["B04", "目标已被另一手机连接", "连接失败；提示解除占用"],
        ["G01", "无 write 或无 notify", "CHANNEL_MISSING"],
        ["G02", "两个 write+notify service", "CHANNEL_AMBIGUOUS"],
        ["G03", "同一 service 有多个业务 write/notify", "固件验收拒绝，避免依赖枚举顺序"],
        ["G04", "notify 订阅失败", "不发送 get_info"],
        ["F01", "JSON 分成 2/5/20 个 BLE 分片", "缓存至 LF 后只解析一次"],
        ["F02", "一次通知含 2 条 JSON", "按 LF 解析两帧"],
        ["F03", "半帧 5 秒无后续", "丢弃/报超时；不无限缓存"],
        ["F04", "非法 UTF-8/JSON", "协议错误；设备不启动"],
        ["F05", "最大 auth 帧 iOS/Android", "不截断；签名仍一致"],
    ]
    story.append(table(["编号", "场景", "期望"], tests, widths=[16, 83, 71], font_size=6.8))
    story.append(PageBreak())


def add_test_matrix_two(story):
    story.append(h1("19.2 联调测试：签名、状态与恢复"))
    tests = [
        ["A01", "正常 get_info→auth→status=2", "只生成 1 张工单；只扣选择的 usage_count"],
        ["A02", "HMAC 改 1 位", "1001；status 保持 1"],
        ["A03", "canonical 字段调序", "1001"],
        ["A04", "把 64 字符 Key hex decode", "测试向量不匹配；修正为 UTF-8 文本"],
        ["A05", "auth 超过 expire_at", "1002；不启动"],
        ["A06", "expire_at-issued_at > 30", "1002；不启动"],
        ["A06B", "RTC 缺失、回退或偏差超约定", "1010/安全拒绝；不得永久接受"],
        ["A07", "nonce 与当前 info 不同", "1003"],
        ["A08", "重复发送已成功 nonce", "1004/1005；不重复启动"],
        ["A09", "device_id/type 与本机不同", "1006/1007"],
        ["A10", "usage_count 0/1.5/1000", "1011"],
        ["R01", "auth_result 通知丢失", "query_status 返回 2；恢复同一工单"],
        ["R02", "auth_result 与 status 都超时", "状态未知；禁止重发 auth"],
        ["R03", "status=2 后小程序崩溃", "本机进度恢复并确认同一工单"],
        ["R04", "confirm 网络响应丢失，重放 10 次", "服务端幂等返回同一工单，不重复扣次"],
        ["R05", "设备工作中断电", "重启恢复原 WORKING/nonce/usage_count"],
        ["R06", "持久化失败", "设备安全停机；不得先回 success"],
        ["R07", "资格剩余 7 秒", "授权 expire_at 不超过剩余 7 秒"],
        ["R08", "授权已签发后尝试换设备", "客户端/服务端均拒绝"],
        ["R09", "工单已完成再次扫码", "打开原工单；不重复扣次"],
        ["R10", "第一次 confirm 晚于 authorization 到期", "记录 v114 当前拒绝边界；设备应立即回执并确认"],
    ]
    story.append(table(["编号", "场景", "期望"], tests, widths=[16, 87, 67], font_size=6.8))
    story.append(PageBreak())


def add_release_checklist(story):
    story.append(h1("20. 开发交付与发布门槛"))
    story.append(h2("20.1 固件交付清单"))
    checklist = [
        "device_id、device_type、ble_name 与二维码样品一致。",
        "唯一业务 GATT 候选；write/notify 属性在 iOS/Android 可用。",
        "UTF-8 JSON Lines 正确处理分片、粘包、空行、非法帧和最大帧。",
        "四组命令 get_info/info、auth/auth_result、query_status/status 字段匹配。",
        "通过公开 HMAC 测试向量；Key 按 64 个文本字节解释；常量时间比较。",
        "nonce 使用 CSPRNG；成功后 used 持久化；断电不回滚。",
        "WORKING 先持久化再启动；通知丢失仍可 query_status 恢复。",
        "400/403/404/1001–1015 返回结构化失败，不泄露安全信息。",
        "设备时长与业务参数使用受控配置，不在通信协议中擅自写死。",
        "生产 Key 安全注入、读保护、调试口和日志清理已验收。",
    ]
    story += bullets([f"[ ] {item}" for item in checklist], compact=False)
    story.append(h2("20.2 小程序/后端交付清单"))
    app_checklist = [
        "扫码错误已按第 4 节拆分，错误卡片含标题、说明、下一步和错误码。",
        "资格、授权、状态恢复与本机进度均通过真机断网/杀进程测试。",
        "authorization 签发后禁止换设备、重复签发、盲目重发 auth。",
        "日志脱敏，不出现 Key、完整签名、二维码 code 或完整 token。",
        "云函数 Key 与设备测试批次一致；SQL 约束和 v114 健康检查通过。",
        "iOS/Android 至少各两款真机完成第 19 节测试。",
    ]
    story += bullets([f"[ ] {item}" for item in app_checklist], compact=False)
    story.append(callout(
        "签字条件",
        "固件、后端、小程序与 QA 必须共同确认：字段、canonical 顺序、Key 字节解释、时效、状态值、错误码和测试向量完全一致。任一变化都应升级协议版本并重新验收。",
        "ok",
    ))
    story.append(PageBreak())


def add_appendix(story):
    story.append(h1("附录 A：完整正常报文示例"))
    story.append(h2("A.1 get_info"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"get_info","ts":1735689600}\n'))
    story.append(h2("A.2 info"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"info","ok":true,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","ble_name":"LA-C8C5B9","status":1,"nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("A.3 auth（signature 由云函数生成）"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth","auth":{"command":"enter_work","device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff","usage_count":1,"issued_at":1735689600,"expire_at":1735689630,"signature":"<64-lowercase-hex>"}}\n'))
    story.append(h2("A.4 auth_result"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("A.5 query_status / status"))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"query_status"}\n'))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"status","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("附录 B：实现审计路径"))
    story.append(table(
        ["内容", "仓库文件"],
        [
            ["小程序 BLE 收发与错误", "miniprogram-app/miniprogram/services/ble-verification.js"],
            ["页面 90 秒资格与恢复", "miniprogram-app/miniprogram/pages/verification/index.js"],
            ["服务端授权签名与确认", "cloudfunctions/faceRecognition/index.js"],
            ["身份格式数据库约束", "database/cloudbase-console/069-01-magic-soft-skin-ble-identity.sql"],
        ],
        widths=[55, 115],
    ))
    story.append(callout(
        "最终说明",
        "本规范以当前仓库和 faceRecognition v114 为准。设备厂商不得根据营销资料、旧版口头说明或二维码外观自行推断协议。联调问题必须附错误码、阶段、时间、App/固件版本与脱敏设备编号。",
        "info",
    ))


def add_firmware_cover(story):
    story.append(Spacer(1, 24 * mm))
    story.append(Paragraph("BLE 设备端固件", styles["CoverTitle"]))
    story.append(Paragraph("开发与交付规范 V1.0", styles["CoverTitle"]))
    story.append(Spacer(1, 3 * mm))
    story.append(Paragraph("魔法柔肤 LASER-BLE｜设备厂家 / 嵌入式固件团队专用", styles["CoverSub"]))
    story.append(Spacer(1, 9 * mm))
    story.append(callout(
        "文档用途",
        "本文件只规定设备端必须实现的身份烧录、二维码标签、BLE 广播、GATT 通道、报文解析、HMAC 验签、状态机、掉电恢复、错误码和交付测试。调用端页面、移动端平台接口和云端业务代码不在本文交付范围内。",
        "info",
    ))
    story.append(Spacer(1, 4 * mm))
    story.append(table(
        ["项目", "V1.0 固定值"],
        [
            ["设备编号", "device_id = LA + 12 位大写十六进制"],
            ["设备类型", "device_type = LASER-BLE"],
            ["广播名称", "ble_name = LA- + device_id 末 6 位"],
            ["线协议", "UTF-8 JSON Lines；每条 JSON 以 LF（0x0A）结束"],
            ["授权算法", "HMAC-SHA256；设备 nonce；授权窗口最长 30 秒"],
            ["服务端基线", "faceRecognition v114"],
            ["文档日期", str(date.today())],
        ],
        widths=[38, 132],
    ))
    story.append(Spacer(1, 9 * mm))
    story.append(callout(
        "设备启动红线",
        "设备只有在本机身份、状态、nonce、时间窗、usage_count 和 HMAC 签名全部验证通过，并且 WORKING 状态已成功写入非易失存储后，才允许启动执行机构。任一校验失败都必须保持安全状态。",
        "danger",
    ))
    story.append(PageBreak())


def add_firmware_scope(story):
    story.append(h1("1. 设备端交付范围"))
    story.append(p("设备厂家按本文实现唯一一套 V1.0 固件协议。正文中的字段名、字段类型、状态值、签名顺序、错误码和测试项均为交付要求，不得自行更名、调序或增加另一套兼容协议。"))
    story.append(h2("1.1 设备必须实现"))
    story += bullets([
        "烧录永久 device_id、固定 device_type、共享 BLE_AUTH_SIGNING_KEY，并启用芯片读保护。",
        "生成与本机身份一致的 BLE 广播名和机身二维码标签。",
        "提供一个业务 Service、一个 Write Characteristic、一个 Notify/Indicate Characteristic。",
        "接收 get_info、auth、query_status；返回 info、auth_result、status。",
        "按 LF 对 UTF-8 JSON 字节流分帧，支持分片、粘包、空行与异常帧恢复。",
        "生成一次性 16 字节随机 nonce，验证 HMAC-SHA256 授权并防重放。",
        "持久化 READY/WORKING、nonce 使用状态和当前会话；支持断线、掉电后查询恢复。",
        "返回本文定义的结构化错误码；日志和接口不得泄露生产 Key。",
    ], compact=False)
    story.append(h2("1.2 不属于设备端交付"))
    story += bullets([
        "调用端页面、扫码交互、用户提示文案和移动端蓝牙 API 调用。",
        "人脸验证、门店权限、数据库扣次、工单生成和云函数部署。",
    ], compact=False)
    story.append(h2("1.3 开发前必须回填的硬件参数"))
    story.append(table(
        ["参数", "厂家必须填写", "验收条件"],
        [
            ["Service UUID", "128-bit 完整 UUID", "所有量产批次一致"],
            ["Write UUID", "128-bit 完整 UUID；write 或 writeNoResponse", "可接收完整 auth 字节流"],
            ["Notify UUID", "128-bit 完整 UUID；notify 或 indicate", "CCCD 开启后可连续回帧"],
            ["ATT MTU", "设备支持值与实际协商值", "目标 iOS/Android 真机有记录"],
            ["固件版本", "字符串和读取方式", "每份测试报告可追溯"],
            ["可信时间", "RTC/受保护单调时钟实现", "断电、回退、失效测试通过"],
        ],
        widths=[32, 73, 65],
        font_size=6.9,
    ))
    story.append(PageBreak())


def add_firmware_identity(story):
    story.append(h1("2. 设备身份与二维码标签"))
    story.append(h2("2.1 身份字段"))
    story.append(table(
        ["字段", "固定格式", "示例", "设备端处理"],
        [
            ["device_id", "LA + 12 位大写 0-9/A-F", "LAF82E0CC8C5B9", "永久烧录；正则 ^LA[0-9A-F]{12}$"],
            ["device_type", "固定字符串 LASER-BLE", "LASER-BLE", "永久烧录；参与签名比较"],
            ["ble_name", "LA- + device_id 末 6 位", "LA-C8C5B9", "启动时由 device_id 计算并广播"],
            ["session code", "6 位十进制数字", "382451", "只用于二维码结构；不是密钥"],
        ],
        widths=[31, 49, 42, 48],
        font_size=6.8,
    ))
    story.append(h2("2.2 机身二维码"))
    story.append(code("nc://bind?sn=LAF82E0CC8C5B9&code=382451"))
    story += bullets([
        "协议固定为 nc，路径固定为 bind，参数顺序固定为 sn 在前、code 在后。",
        "sn 必须等于设备实际烧录的 device_id；code 必须恰好 6 位数字。",
        "二维码不得写入 BLE_AUTH_SIGNING_KEY、signature、用户资料、云端 token 或数据库编号。",
        "同一设备的机身文字编号、二维码 sn、info.device_id 和广播名必须一一对应。",
        "每台设备出厂前必须实际扫码解码，并把解码结果列入出厂检验记录。",
    ])
    story.append(h2("2.3 身份自检"))
    story.append(table(
        ["自检项", "失败处理"],
        [
            ["device_id 格式非法", "进入 NOT_READY；禁止广播为可办理状态"],
            ["device_type 不是 LASER-BLE", "进入 NOT_READY；返回 NOT_PROVISIONED"],
            ["Key 缺失或长度不足", "进入 NOT_READY；返回 NOT_PROVISIONED"],
            ["ble_name 与 device_id 推导值不同", "使用推导值；记录配置故障并禁止出厂"],
            ["非易失存储校验失败", "进入 FAULT；禁止执行机构启动"],
        ],
        widths=[80, 90],
    ))
    story.append(PageBreak())


def add_firmware_ble(story):
    story.append(h1("3. BLE 广播、连接与 GATT"))
    story.append(h2("3.1 广播"))
    story += bullets([
        "READY 状态必须发送可连接广播；完整 local name 必须为 LA- + device_id 末 6 位。",
        "完整名称放入 Advertising Data 或 Scan Response，不能只保存在 GAP Device Name。",
        "名称区分大小写，不得附加空格、批次号、固件版本或其他后缀。",
        "WORKING 状态连接断开后仍应以同一名称恢复可连接广播，供调用端重新连接并 query_status。",
        "同一时刻只允许一个业务连接；第二个连接请求不得改变当前会话和输出状态。",
        "业务特征不得要求系统配对或绑定；连接后通过本协议的 HMAC auth 完成业务授权。",
    ])
    story.append(h2("3.2 GATT 结构"))
    story.append(table(
        ["对象", "数量", "属性", "用途"],
        [
            ["业务 Service", "1", "Primary", "承载全部 V1.0 业务命令"],
            ["Write Characteristic", "1", "write 或 writeNoResponse", "调用端向设备发送请求"],
            ["Notify Characteristic", "1", "notify 或 indicate", "设备向调用端返回结果"],
        ],
        widths=[48, 20, 52, 50],
    ))
    story.append(callout(
        "统一通道",
        "身份读取、开机授权、状态查询和错误返回全部共用这一组 Service/Write/Notify，通过 JSON 的 cmd 字段区分。设备不得再暴露第二组同时具备可写和可通知属性的业务 Service。",
        "info",
    ))
    story.append(h2("3.3 通知启用顺序"))
    story += bullets([
        "连接建立后，设备等待调用端写入 CCCD 开启 notify/indicate。",
        "CCCD 未开启时不得主动发送业务回执；收到命令后可返回 400 或等待通知开启，但不得启动设备。",
        "通知开启后，设备按请求 seq 返回对应结果；同一请求只返回一个终态结果。",
        "连接断开不清除 WORKING 会话，不把 nonce_used 改回 false，也不停止已授权的本地流程。",
    ])
    story.append(h2("3.4 厂家 GATT 参数表"))
    story.append(table(
        ["字段", "厂家填写"],
        [
            ["Service UUID", "________________________________________"],
            ["Write UUID / 属性", "________________________________________"],
            ["Notify UUID / 属性", "________________________________________"],
            ["设备最大 ATT MTU", "________________________________________"],
            ["单次最大接收长度", "________________________________________"],
            ["是否需要配对/绑定", "否（V1.0 固定）"],
        ],
        widths=[58, 112],
    ))
    story.append(PageBreak())


def add_firmware_transport(story):
    story.append(h1("4. 字节流与帧格式"))
    story.append(code("UTF8(JSON.stringify(payload)) + LF(0x0A)"))
    story.append(table(
        ["规则", "设备端固定实现"],
        [
            ["字符编码", "UTF-8；字段名为 ASCII；禁止 GBK/本地编码"],
            ["帧结束符", "每帧只用 LF（0x0A）；接收时可 trim 前面的 CR"],
            ["接收分片", "把多次 Write 的字节依次追加到 RX 缓冲区，遇到 LF 才解析"],
            ["接收粘包", "一个 Write 含多条帧时，按每个 LF 逐帧处理"],
            ["空行", "忽略，不改变设备状态"],
            ["非法 UTF-8/JSON", "丢弃当前帧，返回 400；不得执行任何业务动作"],
            ["未知字段", "忽略未知扩展字段；已定义字段仍须严格校验"],
            ["未知 cmd", "返回 404 UNSUPPORTED_COMMAND"],
            ["未知 ver", "返回 1015 PROTOCOL_VERSION"],
            ["RX 上限", "至少 2048 字节；超限丢弃至下一个 LF 并返回 1014"],
            ["半帧超时", "最后一个字节后 5 秒仍无 LF：清空 RX 缓冲，不执行命令"],
        ],
        widths=[38, 132],
    ))
    story.append(h2("4.1 seq 规则"))
    story += bullets([
        "请求 seq 为正整数；响应必须原样回显请求 seq。",
        "get_info 示例使用 seq=1，auth 使用 seq=2，query_status 使用 seq=3；设备不得依赖固定数值决定命令类型，实际以 cmd 为准。",
        "收到重复 seq 且请求内容完全相同时，返回当前权威状态；不得重复启动。",
        "收到重复 seq 但请求内容不同，返回 400 并保持原状态。",
    ])
    story.append(h2("4.2 发送规则"))
    story += bullets([
        "设备输出同样采用 UTF-8 JSON + LF。",
        "单帧超过协商的通知长度时，按原始字节顺序分段通知；只在完整 JSON 末尾发送一个 LF。",
        "不得把 UTF-8 多字节字符从错误位置截断；V1.0 message 使用简短 ASCII 文本即可。",
        "设备发送缓冲区不得把两次不同请求的响应交叉穿插。",
    ])
    story.append(PageBreak())


def add_firmware_commands(story):
    story.append(h1("5. 命令总表"))
    story.append(table(
        ["调用端请求", "设备响应", "允许状态", "作用"],
        [
            ["get_info", "info", "NOT_READY / READY / WORKING", "读取设备真实身份、状态与当前 nonce"],
            ["auth", "auth_result", "仅 READY", "验证一次性服务端授权并原子进入 WORKING"],
            ["query_status", "status", "NOT_READY / READY / WORKING", "在通知丢失、断线或重连后读取权威状态"],
        ],
        widths=[35, 39, 48, 48],
    ))
    story.append(h2("5.1 通用请求字段"))
    story.append(table(
        ["字段", "类型", "要求"],
        [
            ["ver", "string", "固定为 1.0"],
            ["seq", "integer", "正整数；响应原样回显"],
            ["cmd", "string", "get_info / auth / query_status"],
        ],
        widths=[35, 35, 100],
    ))
    story.append(h2("5.2 通用失败响应"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":false,"code":1001,"message":"invalid signature","status":1}\n'))
    story += bullets([
        "cmd 使用该请求对应的结果名：info、auth_result 或 status。",
        "code 使用第 13 节固定数字；message 使用简短诊断，不得包含 Key、完整签名、内存地址或堆栈。",
        "失败响应中的 status 必须是发送响应时的真实状态。",
    ])
    story.append(PageBreak())


def add_firmware_info(story):
    story.append(h1("6. get_info / info"))
    story.append(h2("6.1 接收请求"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"get_info","ts":1735689600}\n'))
    story += bullets([
        "ts 是未签名的调用端时间，只能写入诊断日志，禁止用它校准安全时钟。",
        "NOT_READY、READY、WORKING 均必须响应；不能因为设备忙而不返回身份。",
    ])
    story.append(h2("6.2 成功响应"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"info","ok":true,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","ble_name":"LA-C8C5B9","status":1,"nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(table(
        ["字段", "类型/格式", "设备端来源"],
        [
            ["ver", "string = 1.0", "固件协议常量"],
            ["seq", "integer", "原样回显请求 seq"],
            ["cmd", "string = info", "固定"],
            ["ok", "boolean = true", "固定"],
            ["device_id", "^LA[0-9A-F]{12}$", "受保护身份区"],
            ["device_type", "LASER-BLE", "受保护身份区"],
            ["ble_name", "LA- + ID 末 6 位", "运行时推导"],
            ["status", "0 / 1 / 2", "当前持久化状态"],
            ["nonce", "32 位 hex", "当前会话 nonce；统一输出小写"],
        ],
        widths=[34, 52, 84],
    ))
    story.append(h2("6.3 nonce 生成"))
    story += bullets([
        "进入新的 READY 会话时使用 CSPRNG 生成 16 bytes，并编码为 32 位小写 hex。",
        "禁止使用 rand()、时间戳、MAC 地址、device_id、计数器单独生成 nonce。",
        "同一 READY 会话重复 get_info 返回同一 nonce；只有完成/取消并建立新 READY 会话后才生成新 nonce。",
        "WORKING 状态必须持续返回启动该会话的原 nonce，直到本地流程安全结束。",
    ])
    story.append(PageBreak())


def add_firmware_auth(story):
    story.append(h1("7. auth / auth_result"))
    story.append(h2("7.1 接收授权"))
    story.append(code(
        '{"ver":"1.0","seq":2,"cmd":"auth","auth":{'
        '"command":"enter_work","device_id":"LAF82E0CC8C5B9",'
        '"device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff",'
        '"usage_count":1,"issued_at":1735689600,"expire_at":1735689630,'
        '"signature":"<64-lowercase-hex>"}}\n'
    ))
    story.append(table(
        ["校验顺序", "字段", "设备端要求", "失败码"],
        [
            ["1", "ver/cmd", "1.0 / auth", "1015 或 404"],
            ["2", "本机状态", "必须为 READY（status=1）", "1005"],
            ["3", "command", "必须为 enter_work", "1008"],
            ["4", "device_id", "必须等于本机永久 ID", "1006"],
            ["5", "device_type", "必须等于 LASER-BLE", "1007"],
            ["6", "nonce", "等于当前 nonce 且 nonce_used=false", "1003/1004"],
            ["7", "usage_count", "整数 1-999，并在设备能力范围内", "1011"],
            ["8", "时间窗", "issued_at < expire_at；差值 <=30 秒；未过期", "1002/1010"],
            ["9", "signature", "64 位小写 hex；常量时间比较", "1001"],
        ],
        widths=[20, 35, 82, 33],
        font_size=6.8,
    ))
    story.append(h2("7.2 成功后的原子顺序"))
    story.append(code("validate all fields -> verify HMAC -> persist pending session -> mark nonce used -> persist WORKING -> start output -> send auth_result"))
    story += bullets([
        "持久化内容至少包括：status=2、nonce、nonce_used=true、usage_count、开始时间、剩余进度、协议版本。",
        "任何持久化失败返回 1012，设备保持安全停机，不得启动执行机构。",
        "执行机构启动失败返回 1013，并保存 FAULT/故障状态；不得返回 ok=true。",
        "成功进入 WORKING 后，即使 BLE 通知发送失败，query_status 仍必须返回 status=2。",
    ])
    story.append(h2("7.3 成功响应"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(callout(
        "禁止动作",
        "不得先启动再验签；不得先回 ok=true 再写入存储；不得在连接断开后把 nonce_used 恢复为 false；不得对同一 nonce 重复启动。",
        "danger",
    ))
    story.append(PageBreak())


def add_firmware_key(story):
    story.append(h1("8. BLE_AUTH_SIGNING_KEY"))
    story.append(p("设备与服务端共享同一个 HMAC-SHA256 对称认证 Key。V1.0 全部设备使用同一个 Key，不使用 key_id，不使用按设备或按批次派生 Key。"))
    story.append(h2("8.1 Key 字节解释"))
    story.append(callout(
        "固定规则",
        "生产 Key 以 64 个小写十六进制字符保存，但参与 HMAC 的是这 64 个字符本身的 UTF-8/ASCII 字节，共 64 bytes。设备不得把这串字符 hex decode 成 32 bytes。",
        "danger",
    ))
    story.append(code(
        "正确：key_bytes = UTF8(KEY_TEXT.trim())      # 64 chars -> 64 bytes\n"
        "错误：key_bytes = HEX_DECODE(KEY_TEXT)       # 64 hex -> 32 bytes"
    ))
    story.append(h2("8.2 注入与存储"))
    story += bullets([
        "生产 Key 只允许通过离线受控工装在出厂阶段注入，禁止通过普通 BLE 业务通道写入。",
        "Key 保存于受保护安全区，开启芯片读保护；量产完成后关闭或锁定调试读取能力。",
        "串口日志、故障日志、蓝牙回执、二维码、测试报告均不得出现 Key。",
        "开发样机使用独立测试 Key；生产 Key 不得写入源代码、固件公共常量仓库或群聊。",
        "设备启动时只校验 Key 是否存在及长度是否为 64 个 ASCII 字符，不输出内容或 hash。",
    ])
    story.append(h2("8.3 Key 更换"))
    story += bullets([
        "Key 更换必须在受控停用窗口内同时更新全部目标设备和服务端；只改一端会使全部 auth 返回 1001。",
        "更换后逐台执行测试向量和一次受控 auth；确认无 1001 后才恢复设备使用。",
        "怀疑 Key 泄露时立即停止设备授权、关闭调试接口、替换 Key，并核对异常时段的设备会话。",
    ])
    story.append(PageBreak())


def add_firmware_signature(story):
    demo_key = "0123456789abcdef" * 4
    canonical = (
        "command=enter_work&device_id=LAF82E0CC8C5B9&device_type=LASER-BLE"
        "&usage_count=1&expire_at=1735689630&issued_at=1735689600"
        "&nonce=00112233445566778899aabbccddeeff"
    )
    signature = hmac.new(demo_key.encode("utf-8"), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    wrong_signature = hmac.new(bytes.fromhex(demo_key), canonical.encode("utf-8"), hashlib.sha256).hexdigest()
    story.append(h1("9. HMAC canonical string 与测试向量"))
    story.append(h2("9.1 固定拼接顺序"))
    story.append(code(
        "command=<...>&device_id=<...>&device_type=<...>&usage_count=<...>"
        "&expire_at=<...>&issued_at=<...>&nonce=<...>"
    ))
    story += bullets([
        "字段名全小写；顺序固定；字段之间只使用 &，键和值之间只使用 =。",
        "canonical 内没有引号、空格、换行、JSON 转义或 URL 编码。",
        "usage_count、expire_at、issued_at 使用普通十进制文本，不带小数、前导 + 或科学计数法。",
        "device_id 使用大写规范值；device_type 固定 LASER-BLE；nonce 使用 info 中原始小写值。",
        "HMAC 输入为 canonical 的 UTF-8 字节；输出 signature 为 64 位小写 hex。",
    ])
    story.append(h2("9.2 非生产测试向量"))
    story.append(code(canonical))
    story.append(table(
        ["项目", "值"],
        [
            ["demo key", demo_key],
            ["key bytes", "demo key 文本的 UTF-8，共 64 bytes"],
            ["expected HMAC", signature],
            ["错误值（把 Key hex decode）", wrong_signature],
        ],
        widths=[43, 127],
        font_size=6.7,
    ))
    story.append(h2("9.3 设备验签伪代码"))
    story.append(code(
        "canonical = build_in_fixed_order(auth)\n"
        "expected = HMAC_SHA256(key_text_as_utf8, canonical_as_utf8)\n"
        "expected_hex = lowercase_hex(expected)\n"
        "if !constant_time_equal(expected_hex, auth.signature): return 1001\n"
        "continue_with_persistent_state_transition()"
    ))
    story.append(callout(
        "算法验收",
        "固件在连接真实设备流程前必须离线得到表内 expected HMAC。结果不同即停止联调，依次检查 Key 字节解释、字段顺序、数字文本、大小写和隐藏换行。",
        "ok",
    ))
    story.append(PageBreak())


def add_firmware_clock_state(story):
    story.append(h1("10. 可信时间与状态机"))
    story.append(h2("10.1 时间校验"))
    story += bullets([
        "issued_at 和 expire_at 是 Unix 秒，并包含在签名中；设备不得修改。",
        "必须满足 issued_at < expire_at，且 expire_at - issued_at <= 30。",
        "设备 trusted_now 不得晚于 expire_at；允许的时钟偏差固定为 ±5 秒，但不能扩展 30 秒总窗口。",
        "设备使用 RTC 加防回退记录或受保护单调时钟；get_info.ts 不能作为可信时间。",
        "RTC 未初始化、读失败、明显回退或偏差超限时返回 1010 CLOCK_INVALID，不得永久放行授权。",
    ])
    story.append(h2("10.2 状态机"))
    story.append(table(
        ["内部状态", "status", "允许命令", "设备行为"],
        [
            ["NOT_READY", "0", "get_info / query_status", "身份、Key、时间或配置未就绪；拒绝 auth"],
            ["READY", "1", "get_info / auth / query_status", "保持当前 nonce；允许一次有效 auth"],
            ["WORKING", "2", "get_info / query_status", "拒绝新 auth；持续返回原会话 nonce"],
            ["COMPLETED", "内部", "本地收尾", "保存结果；安全复位；建立新 READY 会话"],
            ["FAULT", "0", "get_info / query_status", "安全停机；返回故障；禁止 auth"],
        ],
        widths=[37, 18, 52, 63],
        font_size=6.8,
    ))
    story.append(h2("10.3 合法转换"))
    story.append(code(
        "boot -> self_check -> READY\n"
        "READY + valid auth -> persist WORKING -> start output -> WORKING\n"
        "WORKING + local completion -> persist completion -> new nonce -> READY\n"
        "any state + unrecoverable fault -> safe stop -> FAULT"
    ))
    story.append(callout(
        "重复 auth",
        "WORKING 状态收到任何 auth 均返回 1005 DEVICE_BUSY，不执行第二次启动。READY 状态收到已使用 nonce 返回 1004 NONCE_USED。",
        "warn",
    ))
    story.append(PageBreak())


def add_firmware_persistence(story):
    story.append(h1("11. 非易失存储、掉电与重连"))
    story.append(h2("11.1 必须持久化的数据"))
    story.append(table(
        ["数据", "写入时机", "恢复用途"],
        [
            ["device_id / device_type / Key", "出厂注入", "身份和验签"],
            ["current nonce / nonce_used", "建立 READY / 接受 auth", "防重放"],
            ["status", "状态转换前", "重启后恢复 READY/WORKING/FAULT"],
            ["usage_count", "接受 auth 时", "恢复本次工作参数"],
            ["开始时间 / 剩余进度", "进入和执行 WORKING 时", "断电后恢复或安全停止"],
            ["协议版本 / 校验信息", "会话建立时", "识别损坏或不兼容记录"],
        ],
        widths=[48, 55, 67],
    ))
    story.append(h2("11.2 掉电规则"))
    story += bullets([
        "READY 掉电：重启后恢复同一未使用 nonce，或原子废弃旧 nonce 后生成新 nonce；不能同时存在两个有效 nonce。",
        "WORKING 掉电：重启后读取原会话并保持 status=2；不得自动回到 READY，不得把 nonce_used 清零。",
        "持久化记录校验失败：进入 FAULT/status=0，安全停机并返回明确错误。",
        "Flash 写入采用双页、日志式或等效原子方案，掉电不能得到半写入的 WORKING 记录。",
    ])
    story.append(h2("11.3 断线规则"))
    story += bullets([
        "BLE 断线只影响传输，不改变业务状态。",
        "READY 断线后继续可连接广播，并在重连后返回同一 nonce。",
        "WORKING 断线后继续本地流程并恢复可连接广播；重连后 query_status 返回原会话 status=2。",
        "auth_result 通知丢失不能撤销已经成功持久化的 WORKING。",
    ])
    story.append(PageBreak())


def add_firmware_status(story):
    story.append(h1("12. query_status / status"))
    story.append(h2("12.1 请求与响应"))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"query_status"}\n'))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"status","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(table(
        ["字段", "要求"],
        [
            ["ver", "固定 1.0"],
            ["seq", "原样回显 query_status 的 seq"],
            ["cmd", "固定 status"],
            ["ok", "成功为 true；失败时带 code/message"],
            ["status", "返回非易失存储中的权威状态 0/1/2"],
            ["device_id/type", "始终返回本机身份"],
            ["nonce", "READY 返回当前 nonce；WORKING 返回启动该会话的 nonce"],
        ],
        widths=[42, 128],
    ))
    story.append(h2("12.2 响应时限"))
    story.append(table(
        ["完整请求帧", "设备必须在", "超时结果"],
        [
            ["get_info", "10 秒内返回 info", "调用端关闭连接；设备不得改变状态"],
            ["auth", "20 秒内返回 auth_result", "调用端转为 query_status；设备不得等待第二个 auth"],
            ["query_status", "5 秒内返回 status", "状态视为未知；设备保持原权威状态"],
        ],
        widths=[42, 55, 73],
    ))
    story.append(callout(
        "状态权威来源",
        "status 必须来自设备持久化状态，不能根据当前 BLE 是否连接、执行机构瞬时电平或上一次发送结果临时猜测。",
        "info",
    ))
    story.append(PageBreak())


def add_firmware_errors(story):
    story.append(h1("13. 设备错误码"))
    rows = [
        ["400", "BAD_REQUEST", "JSON、字段、类型或 seq 非法", "不改变状态"],
        ["403", "FORBIDDEN", "本地安全策略拒绝", "安全停机/保持状态"],
        ["404", "UNSUPPORTED_COMMAND", "cmd 未实现", "不改变状态"],
        ["1001", "INVALID_SIGNATURE", "HMAC 不一致", "保持 READY"],
        ["1002", "AUTH_EXPIRED", "授权时间窗非法或过期", "保持 READY"],
        ["1003", "NONCE_MISMATCH", "auth nonce 不是当前 nonce", "保持 READY"],
        ["1004", "NONCE_USED", "nonce 已使用", "不重复启动"],
        ["1005", "DEVICE_BUSY", "已 WORKING 或不可接收新 auth", "返回当前状态"],
        ["1006", "DEVICE_ID_MISMATCH", "授权 ID 不是本机 ID", "保持安全状态"],
        ["1007", "DEVICE_TYPE_MISMATCH", "授权类型不是 LASER-BLE", "保持安全状态"],
        ["1008", "UNSUPPORTED_OPERATION", "command 不是 enter_work", "不执行"],
        ["1009", "NOT_PROVISIONED", "身份、Key 或安全配置不完整", "status=0"],
        ["1010", "CLOCK_INVALID", "可信时间不可用", "拒绝 auth"],
        ["1011", "INVALID_USAGE_COUNT", "次数非整数或超范围", "保持 READY"],
        ["1012", "PERSIST_FAILED", "会话持久化失败", "安全停机"],
        ["1013", "OUTPUT_START_FAILED", "执行机构启动失败", "进入 FAULT/status=0"],
        ["1014", "FRAME_TOO_LARGE", "RX 帧超过 2048 字节", "丢弃到下一个 LF"],
        ["1015", "PROTOCOL_VERSION", "ver 不是 1.0", "不执行"],
    ]
    story.append(table(["code", "symbol", "触发条件", "设备动作"], rows[:9],
                       widths=[15, 48, 62, 45], font_size=6.7))
    story.append(PageBreak())
    story.append(h1("13. 设备错误码（续）"))
    story.append(table(["code", "symbol", "触发条件", "设备动作"], rows[9:],
                       widths=[15, 48, 62, 45], font_size=6.7))
    story.append(h2("13.1 错误响应结构"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":false,"code":1002,"message":"authorization expired","status":1}\n'))
    story += bullets([
        "seq 回显原请求；cmd 使用对应结果名称；status 返回错误发生后的真实状态。",
        "同一失败原因固定返回同一 code，不能用 message 文本替代 code。",
        "拒绝 auth 时不得产生脉冲、激光、加热、马达或其他工作输出。",
        "错误日志只记录 code、时间、状态和脱敏会话信息，不记录 Key 或完整 signature。",
    ])
    story.append(PageBreak())


def add_firmware_security(story):
    story.append(h1("14. 安全与诊断日志"))
    story.append(h2("14.1 必须记录"))
    story += bullets([
        "固件版本、启动原因、状态转换、错误码、RTC 状态、Flash 持久化结果。",
        "BLE 连接/断开时间、收到的 cmd/seq、响应耗时、当前 status。",
        "device_id 可完整记录在本地受控维修日志；对外测试报告只保留末 6 位。",
        "signature 只记录校验成功/失败，不记录原值；nonce 对外日志只保留首尾各 4 位。",
    ])
    story.append(h2("14.2 永远禁止记录或读取"))
    story += bullets([
        "BLE_AUTH_SIGNING_KEY 明文、完整 Key hash、可导出 Key 的内存转储。",
        "完整 auth.signature、云端 token、用户资料或二维码 session code 的长期明文日志。",
        "通过 BLE 命令、串口普通命令、调试菜单或维护二维码读取生产 Key。",
    ])
    story.append(h2("14.3 生产保护"))
    story += bullets([
        "量产固件关闭测试后门、通用内存读写命令和未认证的工程模式。",
        "烧录后启用芯片读保护；安全区擦除或校验失败时设备进入 NOT_READY。",
        "固件中的错误 message 不包含内存地址、文件路径、断言文本或堆栈。",
        "生产设备不得内置本文 demo key；demo key 只能用于离线算法测试。",
    ])
    story.append(PageBreak())


def add_firmware_factory(story):
    story.append(h1("15. 出厂烧录与逐台检查"))
    story.append(h2("15.1 烧录顺序"))
    story.append(code("write device_id -> write device_type -> inject production Key -> lock protected storage -> program firmware -> self-test -> print/scan QR -> BLE acceptance"))
    story.append(h2("15.2 逐台记录"))
    story.append(table(
        ["记录项", "要求"],
        [
            ["设备编号", "完整 device_id；与机身文字和二维码一致"],
            ["广播名", "手机实际扫描到的 local name"],
            ["固件版本", "可追溯到构建产物和源码版本"],
            ["GATT UUID", "Service/Write/Notify 完整值"],
            ["Key 检查", "只记录已注入/保护已开启，不记录 Key 内容"],
            ["HMAC 测试", "记录 PASS/FAIL 和测试向量版本"],
            ["状态测试", "READY、正常 auth、重复 auth、掉电恢复"],
            ["检验人/时间", "人员、日期、批次"],
        ],
        widths=[45, 125],
    ))
    story.append(h2("15.3 禁止出厂条件"))
    story += bullets([
        "device_id、二维码、广播名任意两项不一致。",
        "存在第二个可写+可通知的业务 Service，导致通道歧义。",
        "离线 HMAC 测试向量不通过，或设备把 Key hex decode。",
        "重复 nonce 可以再次启动，或 WORKING 掉电后回到 READY。",
        "Key 可通过调试口、日志、BLE 或固件镜像直接读取。",
        "任一错误路径会启动执行机构或返回错误的 status。",
    ])
    story.append(PageBreak())


def add_firmware_tests(story):
    story.append(h1("16. 设备端必测用例"))
    tests_one = [
        ["ID01", "合法 device_id/type/name", "自检通过，进入 READY"],
        ["ID02", "device_id 含小写或非 hex", "NOT_READY；禁止出厂"],
        ["ID03", "二维码 sn 与本机 ID 不同", "出厂检查失败"],
        ["BLE01", "READY 广播", "名称精确为 LA-末 6 位，可连接"],
        ["BLE02", "WORKING 断线再广播", "可重连并 query_status=2"],
        ["G01", "枚举 GATT", "仅一个业务 write+notify 候选"],
        ["G02", "CCCD 未开启", "不启动、不丢失业务状态"],
        ["F01", "JSON 分 2/5/20 次写入", "收到 LF 后只解析一次"],
        ["F02", "一次 Write 含两帧", "按 LF 顺序处理两帧"],
        ["F03", "半帧 5 秒无 LF", "清空缓存，不执行"],
        ["F04", "非法 UTF-8/JSON", "400；状态不变"],
        ["F05", "帧超过 2048 字节", "1014；丢弃至 LF"],
        ["I01", "READY get_info", "身份正确、status=1、nonce 32 hex"],
        ["I02", "重复 get_info", "同一 READY 会话返回同一 nonce"],
    ]
    story.append(table(["编号", "输入/场景", "设备期望结果"], tests_one,
                       widths=[18, 78, 74], font_size=6.8))
    story.append(PageBreak())
    story.append(h1("16. 设备端必测用例（续）"))
    tests_two = [
        ["A01", "正常测试向量", "HMAC 与 expected 完全一致"],
        ["A02", "signature 改 1 位", "1001；保持 READY"],
        ["A03", "canonical 字段调序", "1001"],
        ["A04", "把 64 字符 Key hex decode", "测试向量失败，禁止交付"],
        ["A05", "expire_at 已过期", "1002；不启动"],
        ["A06", "窗口超过 30 秒", "1002；不启动"],
        ["A07", "RTC 失效或回退", "1010；不启动"],
        ["A08", "nonce 不匹配", "1003"],
        ["A09", "同一 nonce 第二次 auth", "1004/1005；只启动一次"],
        ["A10", "ID/type 不匹配", "1006/1007"],
        ["A11", "usage_count=0/1.5/1000", "1011"],
        ["P01", "Flash 写入失败", "1012；执行机构无输出"],
        ["P02", "WORKING 中断电", "重启仍为 status=2 和原 nonce"],
        ["P03", "auth_result 通知丢失", "query_status 返回 2"],
        ["P04", "WORKING 收到新 auth", "1005；不重复启动"],
        ["P05", "执行机构启动失败", "1013；FAULT/status=0"],
    ]
    story.append(table(["编号", "输入/场景", "设备期望结果"], tests_two,
                       widths=[18, 78, 74], font_size=6.8))
    story.append(PageBreak())


def add_firmware_delivery(story):
    story.append(h1("17. 厂家交付清单"))
    checklist = [
        "固件二进制、固件版本号、构建日期和源码版本标识。",
        "Service / Write / Notify UUID、特征属性、最大 ATT MTU 和最大 RX 帧长度。",
        "不少于 3 台设备的 device_id、二维码样张、实际广播名和逐台出厂记录。",
        "第 9 节 HMAC 测试向量的计算结果截图或串口记录，不包含生产 Key。",
        "第 16 节全部用例的 PASS/FAIL 报告，含设备编号末 6 位、固件版本和测试时间。",
        "至少两款 iPhone、两款 Android 的发现、连接、收发完整 auth 帧记录。",
        "READY、正常启动、重复 auth、断线重连、WORKING 掉电恢复的视频或日志证据。",
        "生产 Key 注入工装说明、读保护检查结果、调试口锁定结果。",
        "设备错误码与现场维修手册的对应表。",
        "厂家固件负责人、测试负责人和问题联系窗口。",
    ]
    story += bullets([f"[ ] {item}" for item in checklist], compact=False)
    story.append(h2("17.1 联调放行条件"))
    story.append(table(
        ["放行项", "通过标准"],
        [
            ["身份", "标签、二维码、广播、info 四者一致"],
            ["通道", "唯一业务 GATT；完整 auth 字节流可接收"],
            ["安全", "测试向量一致；Key 不可读；nonce 不可重放"],
            ["状态", "先持久化再启动；重复 auth 不重复动作"],
            ["恢复", "通知丢失、断线、掉电后 query_status 仍返回权威状态"],
            ["错误", "400/403/404/1001-1015 均有稳定结构且不会误启动"],
            ["证据", "测试报告、设备清单、版本和负责人完整"],
        ],
        widths=[42, 128],
    ))
    story.append(callout(
        "交付结论",
        "任一安全、状态持久化、防重放或真实手机长帧测试未通过，设备固件不得进入量产联调。",
        "danger",
    ))
    story.append(PageBreak())


def add_firmware_appendix(story):
    story.append(h1("附录 A：完整正常报文"))
    story.append(h2("A.1 get_info 请求"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"get_info","ts":1735689600}\n'))
    story.append(h2("A.2 info 响应"))
    story.append(code('{"ver":"1.0","seq":1,"cmd":"info","ok":true,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","ble_name":"LA-C8C5B9","status":1,"nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("A.3 auth 请求"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth","auth":{"command":"enter_work","device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff","usage_count":1,"issued_at":1735689600,"expire_at":1735689630,"signature":"<64-lowercase-hex>"}}\n'))
    story.append(h2("A.4 auth_result 成功响应"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("A.5 query_status 请求 / status 响应"))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"query_status"}\n'))
    story.append(code('{"ver":"1.0","seq":3,"cmd":"status","ok":true,"status":2,"device_id":"LAF82E0CC8C5B9","device_type":"LASER-BLE","nonce":"00112233445566778899aabbccddeeff"}\n'))
    story.append(h2("A.6 auth_result 失败响应"))
    story.append(code('{"ver":"1.0","seq":2,"cmd":"auth_result","ok":false,"code":1001,"message":"invalid signature","status":1}\n'))
    story.append(h1("附录 B：厂家回填页"))
    story.append(table(
        ["项目", "厂家回填"],
        [
            ["厂家 / 设备型号", "____________________________________________"],
            ["固件版本", "____________________________________________"],
            ["Service UUID", "____________________________________________"],
            ["Write UUID / 属性", "____________________________________________"],
            ["Notify UUID / 属性", "____________________________________________"],
            ["最大 ATT MTU / RX", "____________________________________________"],
            ["可信时间实现", "____________________________________________"],
            ["非易失存储方案", "____________________________________________"],
            ["Key 注入与读保护", "____________________________________________"],
            ["固件负责人 / 联系方式", "____________________________________________"],
            ["测试负责人 / 日期", "____________________________________________"],
        ],
        widths=[58, 112],
    ))
    story.append(callout(
        "最终确认",
        "厂家签字即表示已按本文实现设备端 V1.0，并确认没有使用 demo key、没有增加第二套业务 GATT、没有在验签和持久化前启动设备。",
        "ok",
    ))


def build() -> str:
    os.makedirs(OUT_DIR, exist_ok=True)
    story = []
    add_firmware_cover(story)
    add_firmware_scope(story)
    add_firmware_identity(story)
    add_firmware_ble(story)
    add_firmware_transport(story)
    add_firmware_commands(story)
    add_firmware_info(story)
    add_firmware_auth(story)
    add_firmware_key(story)
    add_firmware_signature(story)
    add_firmware_clock_state(story)
    add_firmware_persistence(story)
    add_firmware_status(story)
    add_firmware_errors(story)
    add_firmware_security(story)
    add_firmware_factory(story)
    add_firmware_tests(story)
    add_firmware_delivery(story)
    add_firmware_appendix(story)
    DevSpecTemplate(OUT_FILE).build(story)
    return OUT_FILE


if __name__ == "__main__":
    print(build())
