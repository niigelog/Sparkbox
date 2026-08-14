-- 0002_default_user: 播种 V1 的默认账户
--
-- V1 还没有登录体系，插件用固定的一个用户写数据。
-- 单独放一个迁移是为了以后接真实 OAuth 时，能把这个账户的数据平滑迁移过去。

insert into users (id, email, display_name, plan, status)
values (
  '00000000-0000-0000-0000-000000000001',
  'default@sparkbox.local',
  '默认用户',
  'free',
  'active'
)
on conflict (id) do nothing;
