# Gameble Score 小程序

这是 [gameble-score](https://github.com/yorkchung0409/gameble-score) 的原生微信小程序客户端，可直接在微信开发者工具中导入本仓库根目录。

项目通过微信云托管私有链路访问后端，不需要在小程序后台配置服务器域名。

1. 在 `project.config.json` 填入你的小程序 AppID。
2. `app.js` 中的 `CLOUD_ENV` 已配置为 `prod-d4giemw445109b899`，`CLOUD_SERVICE` 已配置为 `gamescore`。它们必须分别与云开发环境 ID 和云托管服务名一致。
3. 将 [gameble-score](https://github.com/yorkchung0409/gameble-score) 仓库部署到同一云开发环境的 `gamescore` 服务，容器端口设为 `3000`，并关闭公网访问。
4. 在云托管服务的环境变量中配置 `DB_NAME`；微信云托管会自动注入关联 MySQL 的 `MYSQL_ADDRESS`、`MYSQL_USERNAME`、`MYSQL_PASSWORD`。已有数据库升级会自动执行版本迁移，只有全新空数据库首次建表时才临时设置 `DB_INIT_ON_START=true`。

`wx.cloud.callContainer` 会在微信私有链路中携带用户身份，服务端使用注入的 OpenID 建立用户，不再需要将 AppSecret 配置到云托管。昵称使用 `input type="nickname"`，由用户主动选择或输入；不会使用已失效的直接用户资料授权接口。

当前项目不含图片对象存储，故未在小程序中持久化微信头像临时文件。接入头像时，应增加对象存储上传接口和 CDN URL 字段，不能把临时路径直接写入数据库。

## 功能

- 扑克：创建或打开账本、最近账本、人员管理、牌局录入、编辑删除、买入/结余/净盈亏明细与零和校验。
- 麻将：微信身份登录、昵称设置、创建或加入房间、转账记账与冲正。
- 实时性：优先 WebSocket，断线自动切换长轮询；连续事件会合并刷新但不会丢失最后状态。

## 上传与回归

- 微信开发者工具应直接导入本仓库根目录；部署后端压缩包不会改变开发者工具的小程序目录。
- 本地路径约定：小程序固定使用 `gameble-score-miniprogram/` 根目录；工作区 `outputs/` 中带年月日和序列号的压缩包属于后端云托管部署，不要导入小程序项目。
- 上传体验版前可执行 `node --test tests/*.test.cjs`，覆盖冷启动预热、并发登录、四人麻将转账、防重复写入、实时事件补刷和四人扑克牌局多选。
