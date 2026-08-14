-- 0004_tags_and_rules: 标签体系 + 规则层自动整理
--
-- 设计要点：
--   * post_tags.source 区分 auto / manual —— 重跑分类只能覆盖 auto 的，
--     用户手动打的标签一根手指都不许碰
--   * 规则命中文件夹时只写 suggested_folder_id，**不动 folder_id**。
--     自动移动会让东西找不到，且违反「folder_id 是用户劳动成果」这条既定原则
--   * classified_at 保证只处理一次，避免反复横跳；
--     classifier_version 变更时可以显式重跑

create table if not exists tags (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  name        text not null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,

  constraint tags_name_not_blank check (length(btrim(name)) > 0)
);

create unique index if not exists tags_user_name_key
  on tags (user_id, name) where deleted_at is null;

drop trigger if exists tags_updated_at on tags;
create trigger tags_updated_at before update on tags
  for each row execute function set_updated_at();

create table if not exists post_tags (
  post_id     uuid not null references saved_posts(id) on delete cascade,
  tag_id      uuid not null references tags(id) on delete cascade,
  source      text not null default 'manual',
  confidence  real,
  created_at  timestamptz not null default now(),

  primary key (post_id, tag_id),
  constraint post_tags_source_check check (source in ('auto', 'manual'))
);

create index if not exists post_tags_tag_idx on post_tags (tag_id);
-- 重跑分类时要按 source 批量删，这个偏索引服务那个操作
create index if not exists post_tags_auto_idx on post_tags (post_id) where source = 'auto';

-- ============================================================
-- 规则层：作者 / 关键词 / 正则
-- ============================================================
create table if not exists classify_rules (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users(id) on delete cascade,
  kind          text not null,
  pattern       text not null,
  action_type   text not null,
  action_value  text not null,   -- action_type=tag 时是标签名，=folder 时是 folders.id
  priority      integer not null default 0,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz,

  constraint classify_rules_kind_check   check (kind in ('author', 'keyword', 'regex')),
  constraint classify_rules_action_check check (action_type in ('tag', 'folder')),
  constraint classify_rules_pattern_len  check (length(pattern) between 1 and 200)
);

create index if not exists classify_rules_user_idx
  on classify_rules (user_id, priority desc, created_at) where deleted_at is null and enabled;

drop trigger if exists classify_rules_updated_at on classify_rules;
create trigger classify_rules_updated_at before update on classify_rules
  for each row execute function set_updated_at();

-- ============================================================
-- saved_posts 上的分类状态
-- ============================================================
alter table saved_posts
  add column if not exists classified_at        timestamptz,
  add column if not exists classifier_version   integer,
  add column if not exists suggested_folder_id  uuid references folders(id) on delete set null;

-- 定时任务每轮捞的就是这批：还没分过类的
create index if not exists saved_posts_unclassified_idx
  on saved_posts (user_id, saved_at desc)
  where deleted_at is null and classified_at is null;
