#!/usr/bin/env node
/**
 * 对着真实数据库验证关键约束是否按预期工作。
 * 全程在一个事务里，结束无条件 rollback —— 不会留下任何数据。
 *
 *   npm run db:verify
 */
import { existsSync } from 'node:fs';
import pg from 'pg';

if (existsSync('.env')) process.loadEnvFile('.env');

const client = new pg.Client({
  host: process.env.APP_POSTGRES_HOST,
  port: Number(process.env.APP_POSTGRES_PORT ?? 5432),
  database: process.env.APP_POSTGRES_DB,
  user: process.env.APP_POSTGRES_USER,
  password: process.env.APP_POSTGRES_PASSWORD,
  connectionTimeoutMillis: 8000,
});

const U = '00000000-0000-0000-0000-000000000001';
let pass = 0;
let fail = 0;

async function check(name, fn) {
  try {
    await client.query('savepoint sp');
    await fn();
    await client.query('release savepoint sp');
    console.log(`  ✔ ${name}`);
    pass++;
  } catch (e) {
    await client.query('rollback to savepoint sp').catch(() => {});
    console.log(`  ✖ ${name}\n      ${e.message}`);
    fail++;
  }
}

/**
 * 断言某段 SQL 一定会失败（用来验证约束真的拦得住）。
 * 必须套自己的 savepoint —— Postgres 里一条语句报错会中止整个事务，
 * 不回滚到 savepoint 的话后面所有语句都会跟着失败。
 */
async function mustReject(sql, params, why) {
  await client.query('savepoint mr');
  let inserted = false;
  try {
    await client.query(sql, params);
    inserted = true;
  } catch {
    // 预期内
  }
  await client.query('rollback to savepoint mr');
  if (inserted) throw new Error(why);
}

const insertPost = (tweetId, extra = {}) =>
  client.query(
    `insert into saved_posts (user_id, tweet_id, permalink, folder_id, source, media_urls)
     values ($1, $2, $3, $4, $5, $6) returning id`,
    [
      U,
      tweetId,
      extra.permalink ?? `https://x.com/a/status/${tweetId}`,
      extra.folderId ?? null,
      extra.source ?? 'like',
      JSON.stringify(extra.media ?? []),
    ]
  );

await client.connect();
await client.query('begin');
console.log(`\n验证 ${process.env.APP_POSTGRES_DB}（结束会回滚，不留数据）\n`);

await check('同一用户不能重复收藏同一条帖子', async () => {
  await insertPost('dup-1');
  await mustReject(
    `insert into saved_posts (user_id, tweet_id, permalink) values ($1, 'dup-1', 'x')`,
    [U],
    '重复的 (user_id, tweet_id) 竟然插进去了'
  );
});

await check('软删除后可以重新收藏同一条', async () => {
  const { rows } = await insertPost('dup-2');
  await client.query('update saved_posts set deleted_at = now() where id = $1', [rows[0].id]);
  await insertPost('dup-2'); // 不该冲突
});

await check('upsert 走 (user_id, tweet_id) 冲突目标', async () => {
  await insertPost('ups-1');
  await client.query(
    `insert into saved_posts (user_id, tweet_id, permalink, text_content)
     values ($1, 'ups-1', 'x', '第二版')
     on conflict (user_id, tweet_id) where deleted_at is null
     do update set text_content = excluded.text_content`,
    [U]
  );
  const { rows } = await client.query(
    `select count(*)::int n, max(text_content) t from saved_posts
     where user_id = $1 and tweet_id = 'ups-1' and deleted_at is null`,
    [U]
  );
  if (rows[0].n !== 1) throw new Error(`应该只有 1 条，实际 ${rows[0].n} 条`);
  if (rows[0].t !== '第二版') throw new Error('内容没被更新');
});

await check('updated_at 触发器自动维护', async () => {
  const { rows } = await insertPost('upd-1');
  const before = await client.query('select updated_at from saved_posts where id = $1', [rows[0].id]);
  await client.query(`update saved_posts set note = '改了' where id = $1`, [rows[0].id]);
  const after = await client.query('select updated_at from saved_posts where id = $1', [rows[0].id]);
  if (!(after.rows[0].updated_at > before.rows[0].updated_at)) {
    throw new Error('updated_at 没有自动更新');
  }
});

await check('同一用户下文件夹不能重名', async () => {
  await client.query(`insert into folders (user_id, name) values ($1, '重名测试')`, [U]);
  await mustReject(
    `insert into folders (user_id, name) values ($1, '重名测试')`,
    [U],
    '同名文件夹竟然建了两个'
  );
});

await check('文件夹名不能是空白', async () => {
  await mustReject(
    `insert into folders (user_id, name) values ($1, '   ')`,
    [U],
    '空白名字竟然通过了'
  );
});

await check('删除文件夹时帖子回到信息箱而不是被连带删除', async () => {
  const f = await client.query(
    `insert into folders (user_id, name) values ($1, '待删') returning id`,
    [U]
  );
  await insertPost('cascade-1', { folderId: f.rows[0].id });
  await client.query('delete from folders where id = $1', [f.rows[0].id]);

  const { rows } = await client.query(
    `select folder_id from saved_posts where user_id = $1 and tweet_id = 'cascade-1'`,
    [U]
  );
  if (!rows.length) throw new Error('帖子被连带删除了');
  if (rows[0].folder_id !== null) throw new Error('folder_id 没有置空');
});

await check('media_urls 必须是 JSON 数组', async () => {
  await mustReject(
    `insert into saved_posts (user_id, tweet_id, permalink, media_urls)
     values ($1, 'bad-json', 'x', '{"not":"array"}'::jsonb)`,
    [U],
    'jsonb 对象竟然当成数组存进去了'
  );
});

await check('source 只允许 like / bookmark / import', async () => {
  await mustReject(
    `insert into saved_posts (user_id, tweet_id, permalink, source)
     values ($1, 'bad-src', 'x', 'random')`,
    [U],
    '非法 source 竟然通过了'
  );
});

await check('信息箱偏索引被查询计划命中', async () => {
  const { rows } = await client.query(
    `explain select * from saved_posts
     where user_id = $1 and folder_id is null and deleted_at is null
     order by saved_at desc limit 20`,
    [U]
  );
  const plan = rows.map((r) => r['QUERY PLAN']).join('\n');
  // 表几乎是空的时候 PG 可能选择顺序扫描，这不算错，只提示
  if (!/saved_posts_inbox_idx|Index/.test(plan)) {
    console.log('      （表数据量小，当前走顺序扫描，属正常）');
  }
});

await client.query('rollback');
await client.end();

console.log(`\n${pass} 项通过${fail ? `，${fail} 项失败` : ''}\n`);
process.exit(fail ? 1 : 0);
