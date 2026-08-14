-- 0001_init: 基础表结构
--
-- 设计约定（后续所有迁移都遵守）：
--   * 主键一律 uuid，不用自增整数 —— 多实例写入不冲突，ID 不泄露业务量
--   * 每张业务表都带 user_id，租户隔离靠它，任何查询都必须带上
--   * created_at / updated_at 由触发器维护，应用层不用管
--   * 删除一律软删除（deleted_at），保留数据可追溯、可恢复
--   * 时间戳统一 timestamptz，永远不用 timestamp

create extension if not exists "pgcrypto";  -- gen_random_uuid()
create extension if not exists "pg_trgm";   -- 正文模糊搜索用
create extension if not exists "citext";    -- 邮箱大小写不敏感

-- ============================================================
-- 通用：updated_at 自动维护
-- ============================================================
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ============================================================
-- 用户
-- ============================================================
create table if not exists users (
  id              uuid primary key default gen_random_uuid(),
  email           citext,                       -- 可空：V1 的默认账户没有真实邮箱
  password_hash   text,                         -- 可空：走 OAuth 时不需要
  display_name    text,
  x_user_id       text,                         -- X OAuth 之后用来关联
  x_handle        text,
  avatar_url      text,
  plan            text not null default 'free',
  status          text not null default 'active',
  last_login_at   timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  deleted_at      timestamptz,

  constraint users_plan_check   check (plan   in ('free', 'pro', 'team')),
  constraint users_status_check check (status in ('active', 'suspended', 'deleted'))
);

-- 唯一约束要排掉软删除的行，否则删了账号邮箱就永久占用
create unique index if not exists users_email_key
  on users (email) where deleted_at is null and email is not null;
create unique index if not exists users_x_user_id_key
  on users (x_user_id) where deleted_at is null and x_user_id is not null;

drop trigger if exists users_updated_at on users;
create trigger users_updated_at before update on users
  for each row execute function set_updated_at();

-- ============================================================
-- 文件夹
-- ============================================================
create table if not exists folders (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  parent_id   uuid references folders(id) on delete set null,  -- 预留嵌套，V1 不用
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint folders_name_not_blank check (length(btrim(name)) > 0)
);

-- 同一用户下不允许重名（软删除的不算）
create unique index if not exists folders_user_name_key
  on folders (user_id, name) where deleted_at is null;
create index if not exists folders_user_idx
  on folders (user_id, sort_order, created_at) where deleted_at is null;

drop trigger if exists folders_updated_at on folders;
create trigger folders_updated_at before update on folders
  for each row execute function set_updated_at();

-- ============================================================
-- 收藏的帖子
-- ============================================================
create table if not exists saved_posts (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,

  -- X 侧的身份
  tweet_id       text not null,
  permalink      text not null,
  author_handle  text,
  author_name    text,
  author_avatar  text,
  text_content   text,
  media_urls     jsonb not null default '[]'::jsonb,
  posted_at      timestamptz,                   -- 原帖发布时间

  -- 用户侧的组织
  folder_id      uuid references folders(id) on delete set null,  -- null = 信息箱（未分类）
  note           text,
  source         text,                          -- like | bookmark | import
  saved_at       timestamptz not null default now(),

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz,

  constraint saved_posts_tweet_id_not_blank check (length(btrim(tweet_id)) > 0),
  constraint saved_posts_media_is_array     check (jsonb_typeof(media_urls) = 'array'),
  constraint saved_posts_source_check       check (source is null or source in ('like', 'bookmark', 'import'))
);

-- 同一用户不重复存同一条帖子。软删除后可以重新收藏，所以要带 where。
-- 这个索引就是插件 upsert 的冲突目标。
create unique index if not exists saved_posts_user_tweet_key
  on saved_posts (user_id, tweet_id) where deleted_at is null;

-- 列表页主查询：某用户按收藏时间倒序
create index if not exists saved_posts_user_saved_at_idx
  on saved_posts (user_id, saved_at desc) where deleted_at is null;

-- 按文件夹筛选
create index if not exists saved_posts_user_folder_idx
  on saved_posts (user_id, folder_id, saved_at desc) where deleted_at is null;

-- 信息箱（未分类）单独走一个偏索引，这是最常打开的视图
create index if not exists saved_posts_inbox_idx
  on saved_posts (user_id, saved_at desc) where deleted_at is null and folder_id is null;

-- 正文模糊搜索
create index if not exists saved_posts_text_trgm_idx
  on saved_posts using gin (text_content gin_trgm_ops);

drop trigger if exists saved_posts_updated_at on saved_posts;
create trigger saved_posts_updated_at before update on saved_posts
  for each row execute function set_updated_at();
