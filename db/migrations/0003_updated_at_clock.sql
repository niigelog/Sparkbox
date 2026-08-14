-- 0003_updated_at_clock: updated_at 改用 clock_timestamp()
--
-- now() 返回的是**事务开始时间**，同一个事务里调多少次都是同一个值。
-- 后果：一个事务内先 insert 再 update，updated_at 会和 created_at 完全相等；
-- 批量更新时所有行的 updated_at 也都一样，审计时间戳等于失真。
-- clock_timestamp() 取的是真实墙上时间，每次调用都不同。

create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = clock_timestamp();
  return new;
end;
$$ language plpgsql;
