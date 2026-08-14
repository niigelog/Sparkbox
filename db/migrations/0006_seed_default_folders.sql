-- 0006_seed_default_folders: 给默认账户播种初始文件夹
--
-- 新用户由 server/identity.mjs 在创建时播种；这里补的是已经存在的默认账户
-- （它是 0002 播出来的，那时还没有这套文件夹），以及「读不到 X cookie、
-- 一直退回默认账户」的场景。
--
-- 信息箱不在其中：它是 folder_id 为 null 的虚拟桶，对每个用户天然存在，
-- 不需要也不应该建成一行（建成行就意味着能被删掉，那未归类的帖子就无处可去）。

insert into folders (user_id, name, sort_order)
select '00000000-0000-0000-0000-000000000001', name, ord
from (values ('文章', 1), ('想法', 2), ('观点', 3), ('建议', 4)) as t(name, ord)
where exists (select 1 from users where id = '00000000-0000-0000-0000-000000000001')
on conflict (user_id, name) where deleted_at is null do nothing;
