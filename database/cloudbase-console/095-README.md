# 095：四类审核短信独立设置

本规则取代094的单一总开关：产品、充值、退费、补录核销分别选择，四项默认关闭。任何在职总部可以修改任意总部人员；小程序与Web共用同一设置，全部关闭即不接收。旧单开关请求仍兼容，代表明确开启／关闭全部四类。模板与发送服务仍未启用，不发送短信。

执行顺序：先确认094已完成；只读运行095-preview.sql，已有095不重复。通过 scripts/cloudbase-pg-change.js 新建完整备份并执行 [095-01-hq-review-sms-categories.sql](095-01-hq-review-sms-categories.sql)，独立运行095-readonly-verify.sql（三项READY）和094-readonly-verify.sql（五项READY）。保留既有显式选择，不改任何业务数据。然后部署staffAccount v104，health和六根文件回下载一致后更新Web与小程序。其他云函数不重传。

当前源码不代表已执行，实际状态见发布回执。
