# 企业官网响应式发布回执

源码提交`b6a41574332fd258ed23ebd3dfff9c55952151e4`已推送origin/main。界面验收见[跨屏展示记录](2026-11-08-public-website-responsive.md)，公开文件清单与SHA-256见[部署核验JSON](../../deployments/public-website-responsive-20261108.verification.json)。

## Web静态资源：已部署并回读

仅发布8份限定资源：company-portal.js、company-mobile.css、company-mobile.js、public-project.js、public-project-mobile.css、public-project-mobile.js、login.html、public-project.html。

使用独立暂存目录及CloudBase CLI 3.8.7，空根路径、不传`/`，`--safe --verify --concurrency 1`，两份HTML入口最后上传，不使用prune。官方最终回执为上传完成：totalFiles=8、successCount=8、failedCount=0、verified=true，远端安全备份保留。

发布过程较长，准备排查线路时首轮已自行完成；复核结果8份公网HTTPS文件全部与源码逐字节SHA-256一致。没有实际启用DNS预加载或TLS例外，没有第二次上传。原始CLI回执、发布前4份旧文件、4份新增文件的404状态及发布后字节核验保存在私有运维目录。没有上传仓库根目录、测试、私有数据或小程序文件。

720项回归通过；旧缓存HTML保持原单栏目行为，新HTML才启用手机六屏，避免静态发布先后顺序影响旧页面。手机、iPad、电脑与宽屏几何及视觉验收完成；同一页面不刷新从390→768→650→1440→390宽度切换，手机六屏与桌面单栏目正确切换、无横向溢出。未做真实手机Safari及微信内置浏览器硬件验收。

## lusizhuoer.com：准备完成，接入未完成

已经保存并用权威DNS独立核对两条TXT：证书验证与CloudBase域名归属。有效证书覆盖lusizhuoer.com及www.lusizhuoer.com，控制台到期时间2027-02-05 19:59:59；私钥没有下载。没有购买套餐、启用付费边缘加速或由本轮开启付费续费。

备案订单仍显示管局审核中。CloudBase添加表单域名归属校验已通过并可选取有效证书，刷新后的自定义域名列表仍为空。域名主机记录`@`和`www`未添加CNAME；当前静态托管默认首页仍为index.html，本轮未改变。故不能把文件发布、TXT或SSL证书成功当作域名已可直接打开官网。当前接入要求见[CloudBase官方说明](https://docs.cloudbase.net/service/custom-domain)。

备案通过后尚需：重新确认订单与证书有效期，完成主域名及www绑定和平台给出的CNAME，配置静态网站路由与公司介绍根入口，验证两域名HTTP／HTTPS、资源、三个项目跳转和原有业务入口；总部Web登录如需配置来源，只能增补明确的两域名并保留旧来源及现有权限。不得降低鉴权或购买套餐作为默认补救。当前默认托管域名还存在平台Content-Disposition下载限制，不将200文件回读宣称为默认域名已通过浏览器访问验收。

## 其它部署状态

没有SQL执行、生产数据写入、云函数改动或小程序上传。本轮仅为公开Web展示及域名接入准备。小程序本体保持原有版本；业务鉴权、充值、核销与审核口径均不变。
