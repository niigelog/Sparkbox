# Sparkbox

X 收藏助手 —— 在 X 上点 ❤️ 时自动抓取帖子，直接写进 Postgres，侧边栏按文件夹管理。

**没有本地缓存层。** 点击 → 内容脚本抓取 → Service Worker 直接 POST 后端 → 成败如实反馈到页面上的提示条。侧边栏也直接读后端接口，不经过 Service Worker。

代价说在前面：**后端没启动时，这次点击会丢**（会弹一条明确的红色提示，并且允许你立刻重点一次）。换来的是链路上少一个会坏的环节 —— 之前的 IndexedDB 发件箱连续制造过两次故障（版本号错配导致收藏全线失败、`get` 未命中时返回 IDBRequest 而非 undefined）。后端在 127.0.0.1，真正的失败场景基本只有"忘了启动服务"。

完整产品方案见 [X收藏插件-开发方案.md](X收藏插件-开发方案.md)。

## 快速开始

```bash
npm install
cp .env.example .env
npm run build
```

在 `chrome://extensions` 打开开发者模式 →「加载已解压的扩展程序」→ 选 `dist/` 目录。

开发时用 `npm run dev` 起 watch，改完代码在扩展页点一下刷新即可。

### 起后端

```bash
npm run db:migrate   # 首次：建表
npm run server       # 起 API，监听 127.0.0.1:7000
```

数据落 Postgres。<http://127.0.0.1:7000/health> 是健康检查，<http://127.0.0.1:7000/api/posts> 能直接看全部数据。

```bash
npm test     # 全部测试
npm run smoke   # 全链路冒烟：模拟点一次 ❤️ 一路走到数据库再读回来
```

`npm test` 里连不上数据库的用例会自动跳过，不会挂在那里。

## 同步目标

`.env` 里的 `SYNC_TARGET` 决定数据往哪送，构建时只把用到的那个打进包：

| 模式 | 说明 | background.js |
|---|---|---|
| `local`（默认） | POST 到 `SYNC_ENDPOINT` | 5 KB |
| `supabase` | 直连 Supabase，自动用默认账户登录 | 713 KB |

本地接口的 payload 字段名和 [supabase/schema.sql](supabase/schema.sql) 完全对齐，两种模式后端表结构可以共用：

```json
{
  "tweet_id": "1234567890",
  "permalink": "https://x.com/elonmusk/status/1234567890",
  "author_handle": "@elonmusk",
  "author_name": "Elon Musk",
  "text_content": "正文 🚀",
  "media_urls": ["https://pbs.twimg.com/media/AAA111"],
  "posted_at": "2026-08-10T09:30:00.000Z",
  "folder_id": null,
  "saved_at": "2026-08-14T02:00:00.000Z"
}
```

### 后端要实现的接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/api/posts` | 全部帖子，按 `saved_at` 倒序 |
| `POST` | `/api/posts` | 按 `tweet_id` **upsert**（重复收藏不能产生两条） |
| `PATCH` | `/api/posts/:tweet_id` | 改 `folder_id` / `note`（移动到文件夹） |
| `DELETE` | `/api/posts/:tweet_id` | **必须幂等**，删不存在的也返回 2xx |
| `GET` | `/api/folders` | `[{id, name, created_at}]` |
| `POST` | `/api/folders` | `{name}` → 返回带 `id` 的文件夹 |
| `PATCH` | `/api/folders/:id` | `{name}` 重命名 |
| `DELETE` | `/api/folders/:id` | 删文件夹，**里面的帖子要回到信息箱**（`folder_id = null`），不能连带删掉 |

`folder_id = null` 表示信息箱（未分类）。返回非 2xx 或连不上时，插件会在页面上弹出带具体原因的失败提示，这次点击不会被保存。

`test/api.test.js` 和 `test/contract.test.js` 会起真实服务进程、连真实数据库跑完整接口测试 —— 用随机 uuid 的临时用户，跑完物理删除该用户（外键 cascade 带走所有数据），不会碰到你的真实收藏。

用 Supabase 模式的话：创建项目 → Authentication 里手动建一个默认用户 → 在 SQL Editor 执行 `supabase/schema.sql` → 填 `.env` 的四个 `SUPABASE_*` / `DEFAULT_*` 变量。

## 目录结构

```
build.mjs                 esbuild 打包；按 SYNC_TARGET 把 #sink 指向对应实现
server/
  index.mjs               API 服务（HTTP 路由、参数校验）
  repo.mjs                SQL，所有查询按 user_id 隔离
  db.mjs                  连接池 + 当前用户
db/migrations/            表结构，按文件名顺序应用
scripts/
  migrate.mjs             迁移工具
  db-verify.mjs           约束验证（事务内跑完回滚）
  smoke.mjs               全链路冒烟
src/manifest.json
src/shared/
  constants.js            信息箱 = folder_id null
  removal.js              取消点赞时该不该撤销（纯函数）
src/background/
  index.js                消息路由；只做内容脚本做不了的事
  sinks/local.js          本地 HTTP 接口
  sinks/supabase.js       Supabase（chrome.storage session adapter）
src/content/
  index.js                捕获阶段监听点击
  trigger.js              like/bookmark → 存，unlike/removeBookmark → 撤销
  extract.js              帖子内容提取
  toast.js                Shadow DOM 轻提示
src/sidepanel/            文件夹树 UI
test/                     jsdom 单测 + 真实 HTTP 服务测试
supabase/schema.sql
```

## 几个绕不开的实现约束

写在这里是因为这几点不是风格选择，是不这么做就一定会坏：

1. **content script 必须打成 IIFE。** MV3 的 `content_scripts` 只接受经典脚本，ESM 会直接报错。
2. **点击监听必须用捕获阶段。** X 点击后会把 `data-testid` 从 `bookmark` 改成 `removeBookmark`，冒泡阶段再读已经分不清是收藏还是取消收藏了。
3. **只能用 `data-testid` 定位。** X 的类名（`css-146c3p1` / `r-bcqeeo` …）是 Emotion 生成的哈希，每次发版都变；`aria-label` 跟着界面语言变。两者都不能做选择器。
4. **提取要先排掉引用推文。** 引用推被包在 article 内的 `div[role="link"]` 里，直接 `querySelector` 会抓到引用推的正文和作者。
5. **Supabase 模式下必须换 session storage adapter。** SDK 默认写 `localStorage`，Service Worker 里没有这个对象。同时 `autoRefreshToken` 必须关掉——它靠 `setInterval` 续期，SW 一休眠计时器就没了，醒来后拿着过期 token 静默失败。改成每次调用前手动检查过期时间。

## 安全边界

Supabase 模式下，anon key 和默认账户密码是**明文打包进 `dist/` 的**，任何人解压插件就能拿到完整读写权限。RLS 在这里不提供任何保护——所有数据都属于同一个 `user_id`。**在换成真实 OAuth 登录之前，这个插件只能自用，不能上架、不能分发给第二个人。**

本地模式没有这个问题（接口在 127.0.0.1，不出本机），但同样意味着换台机器数据就没了。

## 当前状态

已验证：64 条测试全过。覆盖打包产物的端到端点击流程、以及连真实数据库跑的 HTTP 接口测试和客户端字段映射契约测试。全链路冒烟（`npm run smoke`）从模拟点赞一路验到 Postgres 再读回来，通畅。

**抓取质量已在真实 x.com 数据上核对过**：作者名/handle 正确拆分、emoji 保留、配图不混入头像、`posted_at` 是原帖时间。

未验证：文件夹 UI 尚未在真实浏览器里完整点过一遍。

还没做：
- 键盘快捷键 `b` 收藏抓不到（走的不是 click 事件）
- 视频只存了封面图，真视频地址需要走 API
- 在 X 原生书签页/喜欢页取消，插件抓不到（只监听帖子卡片上的按钮点击）
- 历史收藏无法批量导入，只能从现在开始逐条积累
- 长 thread 只抓当前这一条
- 文件夹不支持嵌套（`folders.parent_id` 建了但没用）

## 数据库

Postgres。表结构由 `db/migrations/` 下的 SQL 文件定义，按文件名顺序应用。

```bash
npm run db:status    # 看哪些已应用、哪些待应用
npm run db:migrate   # 应用所有未应用的迁移
npm run db:verify    # 对着真实库验证约束（全程事务内，结束回滚，不留数据）
```

连接配置在 `.env` 的 `APP_POSTGRES_*`（`.env` 已 gitignore，不要提交）。

### 迁移工具的几条硬规则

- 每个迁移在**单独一个事务**里执行，失败整体回滚，不会留半截状态
- 已应用的记录进 `schema_migrations`，重复运行是安全的
- **已应用的迁移文件不能再改** —— 内容哈希对不上会直接报错拦下。要改结构就新建一个迁移文件
- `npm run db:migrate -- --dry-run` 只打印计划不执行

### 表结构约定

| 约定 | 原因 |
|---|---|
| 主键一律 `uuid` | 多实例写入不冲突，ID 不泄露业务量 |
| 每张业务表带 `user_id` | 租户隔离靠它，任何查询都必须带上 |
| `created_at` / `updated_at` | 后者由触发器维护，应用层不用管 |
| 删除一律软删除（`deleted_at`） | 数据可追溯、可恢复 |
| 唯一索引都带 `where deleted_at is null` | 否则删掉的行会永久占用唯一值 |
| 时间戳一律 `timestamptz` | 永远不用无时区的 `timestamp` |

三张业务表：`users`（账户、套餐、状态）、`folders`（`parent_id` 预留嵌套）、`saved_posts`（`folder_id` 为 `null` 表示信息箱）。

`saved_posts` 上有 5 个索引，分别服务：按 `tweet_id` 去重（也是 upsert 的冲突目标）、列表倒序、按文件夹筛选、信息箱视图（偏索引）、正文模糊搜索（GIN + trigram）。

**注意 `updated_at` 用的是 `clock_timestamp()` 不是 `now()`** —— `now()` 返回事务开始时间，同一事务内多次调用值相同，会让审计时间戳失真（见 `0003`）。
