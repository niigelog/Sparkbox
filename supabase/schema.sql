-- Sparkbox V1 表结构
-- 在 Supabase 项目的 SQL Editor 里整段执行

create table if not exists folders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  name text not null,
  parent_id uuid references folders(id) on delete set null,
  created_at timestamptz default now()
);

create table if not exists saved_posts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users(id) not null,
  tweet_id text not null,                  -- X 原始帖子 ID，防重复
  permalink text not null,
  author_handle text,                      -- @handle
  author_name text,                        -- 显示名（和 handle 拆开存）
  text_content text,
  media_urls jsonb default '[]'::jsonb,
  posted_at timestamptz,                   -- 原帖发布时间（方案里抓了但漏了字段）
  folder_id uuid references folders(id) on delete set null,  -- null = 未分类
  source text,                             -- like | bookmark，从哪个按钮存进来的
  note text,
  saved_at timestamptz default now(),      -- 用户收藏时间
  created_at timestamptz default now(),
  unique(user_id, tweet_id)
);

create index if not exists saved_posts_user_saved_at_idx
  on saved_posts (user_id, saved_at desc);

-- 行级安全：V1 只有一个默认账户，但先按规范开着
alter table folders enable row level security;
alter table saved_posts enable row level security;

drop policy if exists "用户只能操作自己的目录" on folders;
create policy "用户只能操作自己的目录"
  on folders for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "用户只能操作自己的收藏" on saved_posts;
create policy "用户只能操作自己的收藏"
  on saved_posts for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
