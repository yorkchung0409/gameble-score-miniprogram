# 麻将核心云函数

此函数接收微信平台注入的 OpenID，不信任客户端传来的用户 ID。它负责小程序冷启动、麻将房、扑克私有账本、个人汇总、历史记录、对手统计和管理员概览；小程序日常功能不再调用云托管。

## 云函数配置

- 函数名：`gameble-bootstrap-probe`
- 运行时：Node.js 18.15
- 内存：256 MB
- 超时：3 秒（免费环境上限）
- 匿名访问：关闭

部署时通过函数环境变量配置以下值，勿写入代码或提交到 Git：

```text
DB_HOST=<现有 MySQL 外网地址>
DB_PORT=<现有 MySQL 端口>
DB_USER=gameble_core
DB_PASSWORD=<最小权限账号密码>
DB_NAME=gameble_score
ADMIN_WECHAT_OPENIDS=<管理员微信OpenID，多个用英文逗号分隔>
```

`gameble_core` 只应拥有本函数涉及表的 `SELECT`、`INSERT`、`UPDATE`、`DELETE` 权限，禁止授予 DDL、管理员权限或 root 权限。部署完成后，从同一小程序调用 `wx.cloud.callFunction({ name: 'gameble-bootstrap-probe', data: { action: 'bootstrap' } })`，记录端到端耗时以及响应中的 `metrics.serverElapsedMs`。

## 首次部署前的数据库迁移

本版本为麻将房和扑克账本增加了创建操作幂等字段、用户昵称唯一索引，以及满额抽水所需字段。已有数据库需要先执行一次后端迁移：在 `gameble-score` 目录配置现有 MySQL 环境变量后运行 `node scripts/migrate-db.js`。迁移会把历史的 `微信用户` 默认昵称改成 `微信用户` 加四位数字，并拒绝已有的重复自定义昵称；如迁移提示重复昵称，请先在数据库中人工改名再重试。迁移还会新增 `mahjong_tea_fee_rules.fee_amount` 与 `mahjong_transactions.auto_fee_amount`，并把旧抽水模式转换为百分比模式。云托管版本启动时也会自动检查同一版本；迁移已完成时不会重复修改数据。确认迁移完成后，再让小程序使用新函数。

测试方法：连续静置超过 15 分钟后再调用，分别验证 `bootstrap`、建房、进房和一笔转账。任何写操作失败时，先确认函数环境变量使用的是独立最小权限账号。

## 麻将同步

麻将房不使用 `watch()` 长连接，因此不受个人版实时推送连接数限制。用户自己的写操作直接返回最新房间数据；仍停留在房间前台的其他用户每 15 秒只读取一次房间版本号，只有版本变化时才读取完整账本。页面隐藏或退出时会立即停止检查。
