# Gameble Score 小程序

这是 [gameble-score](https://github.com/yorkchung0409/gameble-score) 的原生微信小程序客户端，可直接在微信开发者工具中导入本仓库根目录。

项目通过微信云函数访问 MySQL 账本，不需要运行云托管，也不需要在小程序后台配置服务器域名。

1. 在 `project.config.json` 填入你的小程序 AppID。
2. `app.js` 中的 `CLOUDBASE_FUNCTION_ENV` 必须与已部署 `gameble-bootstrap-probe` 的云开发环境一致。
3. 在微信开发者工具上传 `cloudfunctions/gameble-bootstrap-probe`，并在函数环境变量中配置独立 MySQL 账号的 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`；若要保留“我的”页管理员入口，也设置 `ADMIN_WECHAT_OPENIDS`。

`wx.cloud.callFunction` 会把微信身份交给函数运行时，服务端使用注入的 OpenID 建立用户，不需要将 AppSecret 配置到任何运行环境。昵称使用 `input type="nickname"`，由用户主动选择或输入；不会使用已失效的直接用户资料授权接口。

当前项目不含图片对象存储，故未在小程序中持久化微信头像临时文件。接入头像时，应增加对象存储上传接口和 CDN URL 字段，不能把临时路径直接写入数据库。

## 功能

- 扑克：创建或打开账本、最近账本、人员管理、牌局录入、编辑删除、买入/结余/净盈亏明细与零和校验。
- 麻将：微信身份登录、昵称设置、创建或加入房间、转账记账与冲正。
- 实时性：麻将房不建立实时推送长连接；前台每 15 秒通过云函数检查一次轻量房间版本，只有版本变化时才读取完整账本。自己的操作由写接口立即返回结果。

## 上传与回归

- 微信开发者工具应直接导入本仓库根目录；部署后端压缩包不会改变开发者工具的小程序目录。
- 本地路径约定：小程序固定使用 `gameble-score-miniprogram/` 根目录；工作区 `outputs/` 中带年月日和序列号的压缩包用于函数和后端留档，不要导入小程序项目。
- 上传体验版前可执行 `node --test tests/*.test.cjs`，覆盖冷启动预热、并发登录、四人麻将转账、防重复写入、房间版本增量刷新和四人扑克牌局多选。
