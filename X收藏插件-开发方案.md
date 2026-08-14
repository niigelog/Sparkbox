# X 平台内容收藏插件 - 开发方案（V1）

> 目标：用户点击 X 原生"收藏"按钮时，插件自动抓取帖子内容并保存到云端数据库，支持目录归类，先用单一默认账户跑通全流程。

---

## 一、产品范围（V1 边界）

**做什么：**
- 监听 X 原生收藏按钮点击
- 抓取帖子结构化内容（正文、作者、媒体、链接、时间）
- 本地缓存 + 云端同步（Supabase）
- 目录（文件夹）归类
- 默认单账户自动登录，无需登录 UI

**不做（留到后续版本）：**
- 多用户登录注册
- AI 摘要/自动打标签/草稿生成
- 全文语义搜索
- 公开分享合集
- 付费墙

---

## 二、整体架构

```
┌─────────────────────┐
│  Content Script      │  监听点击 + 提取帖子 DOM 内容
│  (跑在 x.com 页面里)  │
└──────────┬───────────┘
           │ chrome.runtime.sendMessage
           ▼
┌─────────────────────┐
│ Background Service   │  自动登录 + 写入队列 + 同步逻辑
│ Worker                │
└──────────┬───────────┘
           │
     ┌─────┴─────┐
     ▼           ▼
┌─────────┐  ┌──────────────┐
│IndexedDB│  │ Supabase API  │
│(本地缓存)│  │ (云端数据库)   │
└─────────┘  └──────────────┘
           ▲
           │ 读取/管理
┌─────────────────────┐
│ Side Panel UI         │  目录管理、列表展示、搜索
└─────────────────────┘
```

**设计原则：本地先写、云端异步同步。** 用户点击收藏的瞬间必须立刻在插件里看到反馈，不能因为网络延迟或后端故障而丢失操作。云端同步失败时进入重试队列，不阻塞用户体验。

---

## 三、技术选型

| 模块 | 选型 | 理由 |
|---|---|---|
| 插件框架 | Manifest V3 | Chrome 强制要求 |
| 内容抓取 | Content Script + MutationObserver | 应对 X 的无限滚动/动态渲染 |
| 本地存储 | IndexedDB | 容量大，适合结构化数据，离线可用 |
| 云端数据库 | Supabase（Postgres） | 自带鉴权、Row Level Security、免费额度够 MVP 用 |
| UI 承载 | Chrome Side Panel API | 比传统 popup 更适合常驻浏览的收藏夹场景 |

---

## 四、数据库设计（Supabase / Postgres）

```sql
-- 目录表
create table folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  name text not null,
  parent_id uuid references folders(id),
  created_at timestamptz default now()
);

-- 收藏帖子表
create table saved_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  tweet_id text not null,              -- X 原始帖子 ID，防重复
  permalink text not null,
  author_handle text,
  author_name text,
  text_content text,
  media_urls jsonb,                    -- 图片/视频链接数组
  folder_id uuid references folders(id), -- null = 未分类
  note text,
  saved_at timestamptz default now(),
  unique(user_id, tweet_id)            -- 同一用户不重复存同一条帖子
);

-- 开启行级安全（即使当前只有一个默认账户，也先按规范做）
alter table folders enable row level security;
alter table saved_posts enable row level security;

create policy "用户只能操作自己的目录"
  on folders for all
  using (auth.uid() = user_id);

create policy "用户只能操作自己的收藏"
  on saved_posts for all
  using (auth.uid() = user_id);
```

`unique(user_id, tweet_id)` 让重复收藏同一条帖子时可以直接 `upsert`（存在则更新、不存在则插入），不用前端额外判重。

---

## 五、开发步骤（建议按此顺序推进）

### 阶段 1：Supabase 后端搭建（0.5 天）
1. 创建 Supabase 项目
2. 在 Authentication 页面手动创建一个默认用户（固定邮箱+密码）
3. 执行上面的建表 SQL
4. 记录项目的 `SUPABASE_URL` 和 `anon key`

### 阶段 2：插件骨架（0.5 天）
1. 搭 Manifest V3 基础结构（`manifest.json`、`background.js`、`content.js`）
2. 配置 `host_permissions`：`https://x.com/*`、`https://twitter.com/*`
3. 引入 Supabase JS SDK

### 阶段 3：内容抓取（1-1.5 天）
1. Content script 用事件委托监听收藏按钮点击（`data-testid="bookmark"`）
2. 从点击的按钮向上找到 `article[data-testid="tweet"]` 节点
3. 提取正文（`[data-testid="tweetText"]`）、作者（`[data-testid="User-Name"]`）、媒体（`img`/`video` 的 `src`）、时间（`<time>` 的 `datetime`）、永久链接（含 `/status/` 的 `<a>`）
4. 做好容错：字段抓不到时不报错、不阻断，允许字段为空

### 阶段 4：本地缓存与同步队列（1 天）
1. 用 IndexedDB 存收藏数据，收藏动作先写本地，保证 100% 成功
2. Background script 里维护一个"待同步队列"，写云端失败时暂存，监听 `navigator.onLine` 恢复后重试
3. Background 启动时自动用默认账户登录 Supabase（`signInWithPassword`），全程无登录 UI

### 阶段 5：目录归类与 UI（1-1.5 天）
1. Side Panel 展示收藏列表（卡片视图，还原帖子样式）
2. 支持创建/选择目录，默认收藏进"未分类"
3. 收藏成功后弹出轻量提示条，可选"移动到目录"，不强制打断刷推文的节奏

### 阶段 6：联调与边界测试（1 天）
- 快速连续收藏多条（防抖/防重复请求）
- 断网状态下收藏，恢复网络后验证是否补同步
- 长 thread、纯图片贴、纯转发贴的抓取兼容性

**预计总工期：5-6 天（单人开发，MVP 可用版本）**

---

## 六、核心代码示例

### 6.1 Manifest V3 配置

```json
{
  "manifest_version": 3,
  "name": "X 收藏助手",
  "version": "0.1.0",
  "permissions": ["storage", "sidePanel"],
  "host_permissions": ["https://x.com/*", "https://twitter.com/*"],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "content_scripts": [{
    "matches": ["https://x.com/*", "https://twitter.com/*"],
    "js": ["content.js"],
    "run_at": "document_idle"
  }],
  "side_panel": {
    "default_path": "sidepanel.html"
  }
}
```

### 6.2 Content Script：监听原生收藏按钮

```javascript
// content.js
document.addEventListener('click', (e) => {
  const bookmarkBtn = e.target.closest(
    '[data-testid="bookmark"], [data-testid="removeBookmark"]'
  );
  if (!bookmarkBtn) return;

  // 只处理"收藏"（未被取消收藏时才抓取，避免取消收藏也触发保存）
  if (bookmarkBtn.dataset.testid !== 'bookmark') return;

  const tweetEl = bookmarkBtn.closest('article[data-testid="tweet"]');
  if (!tweetEl) return;

  const postData = extractTweetData(tweetEl);
  chrome.runtime.sendMessage({ type: 'SAVE_POST', payload: postData });
});

function extractTweetData(tweetEl) {
  const textEl = tweetEl.querySelector('[data-testid="tweetText"]');
  const timeEl = tweetEl.querySelector('time');
  const linkEl = timeEl ? timeEl.closest('a') : null;
  const userNameEl = tweetEl.querySelector('[data-testid="User-Name"]');
  const mediaEls = tweetEl.querySelectorAll('img[src*="pbs.twimg.com"], video');

  return {
    tweetId: linkEl ? linkEl.href.split('/status/')[1]?.split('?')[0] : null,
    permalink: linkEl ? linkEl.href : null,
    text: textEl ? textEl.innerText : '',
    authorInfo: userNameEl ? userNameEl.innerText : '',
    mediaUrls: Array.from(mediaEls).map(el => el.src),
    savedAt: new Date().toISOString(),
  };
}
```

### 6.3 Background Script：自动登录 + 双写

```javascript
// background.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const DEFAULT_ACCOUNT = { email: 'default@yourapp.com', password: 'xxxx' };

async function ensureLogin() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) return session;
  const { data, error } = await supabase.auth.signInWithPassword(DEFAULT_ACCOUNT);
  if (error) console.error('自动登录失败', error);
  return data?.session;
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type === 'SAVE_POST') {
    handleSavePost(message.payload);
  }
});

async function handleSavePost(postData) {
  // 1. 先写本地 IndexedDB（伪代码，需替换为真实 IndexedDB 操作）
  await saveToLocalDB(postData);

  // 2. 再异步写云端
  try {
    const session = await ensureLogin();
    if (!session) throw new Error('未登录');

    const { error } = await supabase.from('saved_posts').upsert({
      user_id: session.user.id,
      tweet_id: postData.tweetId,
      permalink: postData.permalink,
      text_content: postData.text,
      author_handle: postData.authorInfo,
      media_urls: postData.mediaUrls,
      folder_id: null,
      saved_at: postData.savedAt,
    }, { onConflict: 'user_id,tweet_id' });

    if (error) throw error;
  } catch (err) {
    console.error('云端同步失败，加入重试队列', err);
    await addToSyncQueue(postData);
  }
}
```

---

## 七、后续可扩展路径（做完 V1 再看）

按之前讨论的优先级，验证完"抓取→存储→归类"这条主链路稳定后，建议按此顺序加功能：

1. 真实多用户登录（X OAuth，替换默认账户）
2. 收藏合集 → AI 生成内容大纲/引用文案草稿（面向内容创作者的核心差异化）
3. 全文/语义搜索
4. 爆款结构拆解、同行灵感雷达
5. 付费墙与订阅体系

---

## 八、需要你提前准备的东西

- 一个 Supabase 账号（免费额度即可起步）
- Chrome 开发者模式下的插件测试环境
- 一个用于自动登录的默认账户邮箱+密码（后续替换成真实登录时会用到迁移逻辑）
