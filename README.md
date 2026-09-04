# Gameble Score 小程序

这是 [gameble-score](https://github.com/yorkchung0409/gameble-score) 的原生微信小程序客户端，可直接在微信开发者工具中导入本仓库根目录。

项目通过微信云托管私有链路访问后端，不需要在小程序后台配置服务器域名。

1. 在 `project.config.json` 填入你的小程序 AppID。
2. `app.js` 中的 `CLOUD_ENV` 已配置为 `prod-d4giemw445109b899`，`CLOUD_SERVICE` 已配置为 `express-drsy`。它们必须分别与云开发环境 ID 和云托管服务名一致。
3. 将 [gameble-score](https://github.com/yorkchung0409/gameble-score) 仓库部署到同一云开发环境的 `express-drsy` 服务，容器端口设为 `3000`，并关闭公网访问。
4. 在云托管服务的环境变量中配置 `DB_HOST`、`DB_PORT`、`DB_USER`、`DB_PASSWORD`、`DB_NAME`，值来自该环境关联的 MySQL 实例。应用启动时会自动执行幂等建表。

`wx.cloud.callContainer` 会在微信私有链路中携带用户身份，服务端使用注入的 OpenID 建立用户，不再需要将 AppSecret 配置到云托管。昵称使用 `input type="nickname"`，由用户主动选择或输入；不会使用已失效的直接用户资料授权接口。

当前项目不含图片对象存储，故未在小程序中持久化微信头像临时文件。接入头像时，应增加对象存储上传接口和 CDN URL 字段，不能把临时路径直接写入数据库。

## 功能

- 德州扑克：创建或打开账本、最近账本、人员管理、牌局录入、编辑删除、买入/结余/净盈亏明细与零和校验。
- 麻将：微信身份登录、昵称设置、创建或加入房间、转账记账与冲正。
