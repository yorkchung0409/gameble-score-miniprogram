# 麻将核心云函数

大备份传输更新：小程序使用传输协议 3，按 12000 字符分段读写。写入分为 begin/chunk/commit；暂存于本人 records_json 的内部 _pending 字段，正式 records 在 commit 校验通过后一次性替换。暂存有效期一小时，新上传替换旧暂存；中断不影响正式记录，提交响应丢失通过 _lastUpload 防重复。读取固定版本，数据发生变化返回 VERSION_CONFLICT。无需修改表结构，部署时必须同步上传新版 bookkeeping-core.js 并更新小程序。

2026-10-08 条件读取：协议 3 的首段请求可携带 `ifVersion`。版本相同时只查询并返回本人版本号及 `notModified: true`，不读取、解析或传输完整记账 JSON；版本不同时直接返回新版本的首段，后续分段仍固定该版本。本次无需 SQL 迁移，上传完整函数目录并更新小程序后生效。

此函数接收微信平台注入的 OpenID，不信任客户端传来的用户 ID。它负责小程序冷启动、麻将房、个人扑克记账、个人汇总、历史记录、对手统计和管理员概览；原多人扑克账本操作已停用，小程序日常功能不再调用云托管。

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

2026-09-28 个人记账版：先在 SQL 编辑器执行后端 `scripts/20260928-personal-bookkeeping.sql`，或在后端终端执行 `node scripts/migrate-db.js`，新增 `personal_bookkeeping`。再上传整个函数目录，必须包含 `bookkeeping-core.js`、`bookkeeping-model.js` 及更新后的 `index.js`、`profile-core.js`。旧表不删除，旧多人账本数据不转入个人记账。

新操作 `getBookkeeping` 和 `saveBookkeeping` 由微信身份隔离；保存携带版本号，冲突返回 `VERSION_CONFLICT`。每人最多 2000 条、记录 JSON 最多 800 KB。个人记账不参与每日六个月清理；前台进入页面或下拉刷新同步，断网不承诺保存成功。数据库账号需要新表的 SELECT/INSERT/UPDATE/DELETE 权限，仍不需要 DDL 权限。

网页备份兼容版使用 `formatVersion: 2` 请求/响应，`records_json` 内保存 version 2 备份对象（records、blinds、tags），不再只保存数组。读取兼容旧数组；保存仅接受新版协议，避免旧客户端丢失盲注、多标签、空时长及未使用字典。该更新无需新 SQL，上传整个函数后再更新小程序。

2026-09-22 修复版：先在 `gameble_score` 数据库 SQL 编辑器完整执行
`scripts/20260922-poker-history.sql`，或在后端目录运行 `node scripts/migrate-db.js`。
只新增 `poker_ledger_snapshots.aggregates_json` 字段，保存每个玩家的历史输赢、买入、场次及账本总场次；重复执行不会重复归档或清空数据。
然后上传整个 `gameble-bootstrap-probe` 云函数目录（包括新增的 `poker-history.js`），最后发布小程序。
原有 `dailyRetentionCleanup` 名称与每日三点配置保持不变。
清理入口必须同时满足平台注入的 `SOURCE === 'wx_trigger'`、没有客户端 OpenID、事件名称为 `dailyRetentionCleanup`；模拟客户端 Timer 参数会返回 FORBIDDEN。
不要将缺失 SOURCE 当作可信调用；若线上触发器被拒绝，应检查平台日志的来源配置。

旧版已删除明细的账本无法恢复其他玩家的历史数字。旧版个人汇总保留，有旧版汇总的账本会提示统计缺失并阻止更换本人，以免混算；新快照不受此限制。
没有执行补字段时清理会失败回滚，不能跳过快照写入直接删明细。
云托管备用版本也使用同一清理实现；如仍有旧云托管服务运行，需同步更新，避免它继续用旧版清理算法。

本版本为麻将房和扑克账本增加了创建操作幂等字段、用户昵称唯一索引、昵称一次性修改标记，以及满额抽水所需字段。已有数据库需要先执行一次后端迁移：在 `gameble-score` 目录配置现有 MySQL 环境变量后运行 `node scripts/migrate-db.js`。迁移会把历史的 `微信用户` 默认昵称改成 `微信用户` 加四位数字，并将已有自定义昵称标记为已修改；如迁移提示重复昵称，请先在数据库中人工改名再重试。迁移还会新增 `users.nickname_changed_at`、`mahjong_tea_fee_rules.fee_amount` 与 `mahjong_transactions.auto_fee_amount`，并把旧抽水模式转换为百分比模式。云托管版本启动时也会自动检查同一版本；迁移已完成时不会重复修改数据。确认迁移完成后，再让小程序使用新函数。

函数目录的 `config.json` 已配置每日定时清理。部署函数后请在云开发控制台确认 `dailyRetentionCleanup` 定时触发器存在；它会将六个月以前的扑克/麻将明细汇总进快照后再删除明细。免费环境默认每次只处理一批 25 条，避免超过三秒执行时间；历史较多时会在后续日期继续处理。

测试方法：连续静置超过 15 分钟后再调用，分别验证 `bootstrap`、建房、进房和一笔转账。任何写操作失败时，先确认函数环境变量使用的是独立最小权限账号。

## 麻将同步

麻将房不使用 `watch()` 长连接，因此不受个人版实时推送连接数限制。用户自己的写操作直接返回最新房间数据；仍停留在房间前台的其他用户每 15 秒只读取一次房间版本号，只有版本变化时才读取完整账本。页面隐藏或退出时会立即停止检查。
