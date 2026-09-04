# Gameble Score 小程序

这是 [gameble-score](https://github.com/yorkchung0409/gameble-score) 的原生微信小程序客户端，可直接在微信开发者工具中导入本仓库根目录。

1. 在 `project.config.json` 填入你的小程序 AppID。
2. 在 `app.js` 的 `API_BASE_URL` 配置已部署的 HTTPS 后端地址，例如 `https://score.example.com`。
3. 在小程序后台的「开发管理 - 开发设置」添加该 API 域名为合法 request 域名。
4. 在服务端环境变量配置同一个小程序的 `WECHAT_APP_ID` 与 `WECHAT_APP_SECRET`，然后重启后端。

小程序通过 `wx.login` 获取临时 code，再交给服务端调用微信 `jscode2session` 接口换取 openid。昵称使用 `input type="nickname"`，由用户主动选择或输入；不会使用已失效的直接用户资料授权接口。

当前项目不含图片对象存储，故未在小程序中持久化微信头像临时文件。接入头像时，应增加对象存储上传接口和 CDN URL 字段，不能把临时路径直接写入数据库。
