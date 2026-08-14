-- 0005_drop_auto_classify: 移除自动整理（规则层）
--
-- 标签体系、分类规则、归档建议全部下线。
-- 这会连带删掉 tags / post_tags / classify_rules 里的数据 ——
-- 那些内容都是规则自动产出的，没有手工价值。

drop index if exists saved_posts_unclassified_idx;

alter table saved_posts
  drop column if exists classified_at,
  drop column if exists classifier_version,
  drop column if exists suggested_folder_id;

-- post_tags 有指向 tags 的外键，先删它
drop table if exists post_tags;
drop table if exists tags;
drop table if exists classify_rules;
