# 露思卓儿移动业务小程序

这是现有 CloudBase 系统的原生微信小程序客户端，不复制 PostgreSQL 规则，直接复用测试环境 `rusizhuoer-d9gbcsgym07651694` 中的 `staffAccount` 和 `faceRecognition` 服务端逻辑。

## 当前完成范围

1. 小程序外壳、CloudBase 连接和移动端基础 UI。
2. 现有手机号＋密码登录和用户点击授权的微信手机号快捷登录，服务端只按当前 UID 回读总部／门店／老师角色。
3. 总部／门店／老师三种首页：按网页版同一手机视口复现移动导航、标题栏、信息卡、时间筛选、四类业务汇总、横向明细表、客户表和分页；老师办理门店选择、客户查询与客户主页继续使用小程序原生路由。
4. 总部／门店三类数据库查询：客户查询支持门店、业务阶段、状态、建档日期、姓名／生日、直接跳页，以及二次确认后的封存／恢复；充值／核销查询支持门店、项目、类型、审核状态、日期、姓名／生日、直接跳页与精确工单详情。门店查询由服务端锁定本店，总部可以选择全部或具体门店；老师客户页只读。
5. 客户主页、客户历史工单链接、充值／核销数据库详情，以及核销照片缩略图、高清原图预览和无压缩相册保存。
6. 客户现场建立、充值申请、退费申请。
7. 正常核销和老师体验核销；两者都是已选客户的 1:1 人脸校验。

BLE 开机尚未实现。当前核销成功后仍写入现有 `device_signal_outbox` 虚拟设备信号；下一阶段在服务端核销已确认后，再由小程序使用蓝牙 API 发送对应指令。

> 交付边界：当前仓库代码与文档按 `staffAccount v69`、`faceRecognition v90`、`verificationPhoto v9`、`teacherCreate v6` 编排。CloudBase 小程序授权已经成功；手机号＋密码已在开发者工具使用既有账号进入总部主页并完成 `staffAccount.session` 回读。`WX_MICRO_APP` 身份源、微信手机号能力与计费仍未开通验收，当前 AppID 的正式 `request` 合法域名和真机验收也未完成。本轮没有修改或上传云函数，也没有发布小程序，因此线上仍不能视为已支持微信手机号快捷登录。

## 登录最终规则

- 手机号＋密码与微信手机号授权必须登录到同一既有 CloudBase Auth 用户和同一 UID；微信授权只是该账号的另一种认证方式，不创建第二业务身份。
- 手机号授权只能由用户点击 `open-type="getPhoneNumber"` 按钮发起。小程序只把按钮返回的一次性 code 交给 CloudBase SDK，不解密、不记录、不持久化该 code。
- CloudBase 验证微信手机号并关联既有 Auth 用户后，小程序调用无手机号参数的 `staffAccount.session`。服务端只按平台认证的当前 UID 回读员工、角色、账号状态和门店范围。
- 客户端输入或传入的手机号不是身份证明。禁止用手机号自动创建或替换 `staff_accounts.auth_uid`；UID 未命中已有员工账号时必须登录失败、退出 CloudBase 会话并清理本地业务会话。
- 陌生手机号不得自动注册 CloudBase Auth 用户、员工账号或业务角色。封存员工即使仍有未过期客户端令牌，每次服务端回读也必须拒绝。
- 手机号＋密码继续作为应急和配置故障时的备用登录方式。

## CloudBase 与微信前置配置

1. 在与现有 Auth 用户、云函数和 PostgreSQL 相同的 CloudBase 环境中启用 `WX_MICRO_APP` 身份源，配置当前小程序 AppID 和 AppSecret。
2. 显式配置 `On=TRUE`、`AutoSignInWhenPhoneNumberMatch=TRUE`、`AutoSignUpWithProviderUser=FALSE`、`TransparentMode=FALSE`、`ReuseUserId=FALSE`，并保持用户名／手机号＋密码登录开启。不得依赖控制台默认值。
3. 将 `staffAccount`、`faceRecognition`、`verificationPhoto` 等业务云函数的安全规则继续限定为已登录且非匿名用户；微信登录成功不代表已获得总部、门店或老师权限。核销照片清单和高清原图由独立 `verificationPhoto` 服务读取，不把照片流量重新压回人脸与业务主函数。
4. AppSecret 只能保存在 CloudBase 身份源的服务端密钥位。快捷登录不新增小程序端密钥，不需要自建微信解密云函数、Custom Login 私钥或自定义 ticket。
5. 微信小程序必须是已完成认证的非个人主体。发布前在微信公众平台完成手机号用途的用户隐私保护指引、接口声明和页面明确授权文案。
6. 按微信和 CloudBase 当期政策开通小程序手机号验证能力及相应套餐／计费；模拟器无法替代真实微信账号和真机验收。

## 已验证开发基线

- 当前开发 AppID：`wxb053c1bd6c684d8b`。AppID 是公开标识，不是密钥；若以后切换正式小程序，必须同时更新 `project.config.json`、微信公众平台合法域名和 CloudBase 环境授权。
- CloudBase 测试环境：`rusizhuoer-d9gbcsgym07651694`，区域 `ap-shanghai`。
- CloudBase JS SDK：`3.7.1`，与当前网页版登录 SDK 对齐；`@cloudbase/adapter-wx_mp` 为 `1.3.1`。
- Node.js 最低版本：`20.19.0`；当前已验证版本为 Node.js `24.19.0` LTS。
- 包管理器：pnpm `9.15.9`，版本已写入 `miniprogram/package.json`。仓库只维护 `pnpm-lock.yaml`，不要另行生成 `package-lock.json`。
- 微信开发者工具已验证版本：macOS Apple Silicon `2.02.2608040`。
- 仓库目标服务端版本：`staffAccount v69`、`faceRecognition v90`、`verificationPhoto v9`、`teacherCreate v6`。
- 小程序登录页使用根据露思卓儿金色水滴／侧脸 Logo 视觉语言生成的暖象牙白、浅香槟金竖屏背景，不使用人物照、“海洋之韵”文字或图片内生成文字；背景 Logo 轮廓清晰可辨但不抢表单，“露思卓儿”四字和全部登录控件由 WXML 精确渲染并完整居中放入弧形暖白框，整体色调不得压暗。总部、门店、老师首页在相同手机内容视口下逐项复现网页版的模块顺序、字号、间距、颜色、圆角、按钮网格、表格列宽和滚动方式；微信状态栏、右上角胶囊、原生导航栏与浏览器地址栏属于平台差异。WXML/WXSS、小程序会话和微信能力仍与网页 HTML/CSS、浏览器会话物理隔离，禁止跨目录导入客户端源码。

## 首次安装、导入与运行

1. 安装 Node.js `>=20.19.0`，并启用仓库指定的 pnpm：

   ```bash
   corepack enable pnpm
   corepack install --global pnpm@9.15.9
   ```

2. 从仓库根目录安装小程序依赖：

   ```bash
   cd miniprogram-app/miniprogram
   pnpm install --frozen-lockfile
   ```

   `--frozen-lockfile` 防止依赖漂移；版本控制内的 `miniprogram/.npmrc` 固定使用 `node-linker=hoisted`，生成微信开发者工具更容易识别的扁平依赖布局。

3. 在微信开发者工具中导入仓库内的 `miniprogram-app` 目录，不要误选下一层 `miniprogram`。
   现有 CloudBase 是 PostgreSQL 环境；如果开发者工具提示“不支持 PostgreSQL 环境”，直接取消“转换云环境”。不要新建第二环境，小程序会通过 CloudBase JS SDK 和微信适配器调用同一环境中的现有云函数。
4. 选择“工具 → 构建 npm”，确认生成 `miniprogram/miniprogram_npm`。macOS 开启“设置 → 安全设置 → 服务端口”后，也可从仓库根目录执行：

   ```bash
   /Applications/wechatwebdevtools.app/Contents/MacOS/cli build-npm \
     --project "$(pwd)/miniprogram-app" \
     --compile-type miniprogram
   ```

5. 在 CloudBase 中保持现有“用户名/手机号＋密码”登录方式可用，并把 `https://rusizhuoer-d9gbcsgym07651694.ap-shanghai.tcb-api.tencentcloudapi.com` 配入当前 AppID 的微信公众平台 `request` 合法域名。本机开发可以在被 Git 忽略的 `project.private.config.json` 中临时关闭域名校验，但预览、真机和发布不得依赖该开关。2026-08-25 检查时 CloudBase 服务商域名入口提示本月 50 次修改额度已用完；不要继续重复提交，可改为在微信公众平台直接配置，或等待额度恢复。
6. 按“CloudBase 与微信前置配置”启用 `WX_MICRO_APP`，并完成微信主体、认证、隐私和计费前置。CloudBase 环境授权成功不等于微信手机号快捷登录已经启用；合法域名、身份源和真机验收缺一不可。
7. 分别验收密码和微信授权登录。服务端 `session` 回读的 UID、角色和门店必须与既有员工身份一致，两种方式的 UID 必须完全相同，否则不进入工作台。

当前 SDK 依赖在微信开发者工具构建 npm 时可能提示 `bson/lib/bson.cjs.js: Npm package entry file not found`。在上述已验证版本中，npm 构建、登录页编译和模拟器启动均成功，控制台没有运行错误；如果以后升级 SDK 后出现实际的 `module not found`，应统一升级或修正 CloudBase SDK 依赖，不能手工复制一个伪造的 `bson.cjs.js` 掩盖问题。

拍照／相册组件使用 `wx.chooseMedia`，但它不是 `app.json.requiredPrivateInfos` 允许声明的定位类接口，不能把 `chooseMedia` 加回该数组。发布前应在微信公众平台按实际采集用途完成客户照片和员工手机号的用户隐私保护指引、对应接口声明与明确授权说明。

`miniprogram/config/env.js` 只包含公开的环境 ID、区域和函数名。人脸 SecretId、SecretKey、CloudBase API Key、PostgreSQL 密码与 SQL 不得放进小程序。

## 本地自动验收

从仓库根目录执行：

```bash
node --test tests/*.test.js
git ls-files -z '*.js' | xargs -0 -n 1 node --check
cd miniprogram-app/miniprogram
pnpm list --depth 0
pnpm audit --prod
```

交付前还必须在微信开发者工具重新构建 npm、编译 `pages/login/index`，并检查模拟器控制台没有运行错误。`node_modules`、`miniprogram_npm` 和本机 `project.private.config.json` 均已被 Git 忽略。

## P0 防重要求

充值／退费和核销在调用前先把不含客户明文、留言和人脸令牌的请求指纹与 `clientRequestId` 写入小程序本地存储。请求超时或断网后：

- 不会生成新编号再次提交；
- 只能用原 `clientRequestId` 调用 `recoverBusinessSubmission` 查库；
- 数据库结果不确定时继续锁定；
- 只有查到原工单完整成功，或服务端确定拒绝且查库为空，才解除锁定。

此逻辑依赖线上数据库已完整执行相应迁移，尤其是防重字段、核销照片、体验额度审计、设备信号与恢复查询。

## 发布前手工验收

- 同一员工分别使用密码和微信手机号授权登录，CloudBase UID 必须完全相同，角色、状态和门店范围必须一致。
- 用户拒绝授权或授权事件没有 code 时不发起登录；一次性 code 不复用、不记录、不写入本地存储。
- 授权手机号未绑定员工时，CloudBase 和 PostgreSQL 都不新增业务账号，且客户端退出 CloudBase 会话；不能通过伪造手机号修改 `auth_uid`。
- 封存员工的密码与微信授权登录均被服务端拒绝；退出后更换微信用户不能继承上一个员工的本地会话或老师所选门店。
- 分别用总部、门店、老师账号登录；总部只看到查询，门店无体验核销。
- 总部打开“查”菜单后必须看到客户、充值、核销三类查询；总部可切换全部／指定门店，门店账号没有“全部门店”能力且服务端始终锁定本店。
- 客户查询逐项验证业务阶段、活跃／封存、建档日期、姓名／生日、上一页／下一页和页码直跳；充值／核销逐项验证项目、业务类型、审核状态、日期、姓名／生日和页码直跳。
- 从首页业务明细、查询列表和客户历史分别点击工单号，必须进入同一张数据库工单；核销照片点击后重新鉴权读取原图，保存到相册不得在小程序端转码压缩。
- 老师未选门店时不能办理业务；选门店后所有客户和单据都由服务端校验该门店。
- 客户建立必须拍照、服务端检测、人脸建立和客户编号返回均成功。
- 充值不做人脸；退费不允许超过已购未退次数。
- 正常核销只读客户剩余大于 0 的项目；体验核销只读当前老师体验剩余大于 0 的项目。
- 正常与体验都只对所选客户做 1:1 人脸验证，没有 1:N，没有老师人脸。
- 在提交瞬间断网后重进页面，必须先恢复原结果，不能再扣一次。
- 客户照片加载失败后可单独重读；保存到相册使用服务端原图临时地址，小程序不再压缩。
