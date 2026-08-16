/**
 * 身份识别：不同 X 账号的数据必须严格隔离。
 * 临时用户，跑完物理删除，不碰真实收藏。连不上库时跳过。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = 7415;
const BASE = `http://192.168.101.12:${PORT}`;
// 用一个绝不会和真实 X 账号撞上的号段
const XID_A = `999${Date.now()}1`;
const XID_B = `999${Date.now()}2`;
const SEEDED = randomUUID(); // 冒充「播种出来的默认账户」
let proc;
let ready = false;

const api = async (method, path, { body, xUserId, handle, name } = {}) => {
  const headers = {};
  if (body) headers['content-type'] = 'application/json';
  if (xUserId) headers['x-sparkbox-user-id'] = xUserId;
  if (handle) headers['x-sparkbox-handle'] = handle;
  if (name) headers['x-sparkbox-name'] = encodeURIComponent(name);
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

async function pg() {
  const p = (await import('pg')).default;
  const c = new p.Client({
    host: process.env.APP_POSTGRES_HOST,
    port: Number(process.env.APP_POSTGRES_PORT ?? 5432),
    database: process.env.APP_POSTGRES_DB,
    user: process.env.APP_POSTGRES_USER,
    password: process.env.APP_POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  await c.connect();
  return c;
}

before(async () => {
  if (!process.env.APP_POSTGRES_HOST) return;
  try {
    const c = await pg();
    await c.query(`insert into users (id, email, display_name) values ($1, $2, '身份测试种子')`, [
      SEEDED,
      `id-${SEEDED}@sparkbox.local`,
    ]);
    await c.end();
  } catch {
    return;
  }
  proc = spawn('node', ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), APP_DEFAULT_USER_ID: SEEDED },
    stdio: 'ignore',
  });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  proc?.kill();
  if (!process.env.APP_POSTGRES_HOST) return;
  try {
    const c = await pg();
    await c.query('delete from users where id = $1 or x_user_id = any($2)', [
      SEEDED,
      [XID_A, XID_B],
    ]);
    await c.end();
  } catch {}
});

const post = (id) => ({
  tweet_id: id,
  permalink: `https://x.com/a/status/${id}`,
  text_content: '正文',
  media_urls: [],
});

describe('X 身份识别', () => {
  test('不带身份头时退回默认账户', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    const { data } = await api('GET', '/health');
    assert.equal(data.user, SEEDED);
  });

  test('第一个 X 账号认领那个还没被占用的默认账户，历史数据不会变孤儿', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    // 先以默认身份存一条，模拟「切换到身份识别之前」攒的数据
    await api('POST', '/api/posts', { body: post('legacy') });

    const { data } = await api('GET', '/health', { xUserId: XID_A, handle: 'vica' });
    assert.equal(data.user, SEEDED, '应该认领默认账户，而不是新建一个');

    const list = await api('GET', '/api/posts', { xUserId: XID_A });
    assert.ok(
      list.data.some((p) => p.tweet_id === 'legacy'),
      '之前存的数据必须还看得到'
    );
  });

  test('第二个 X 账号拿到独立的新账户', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    const { data } = await api('GET', '/health', { xUserId: XID_B, handle: 'someone' });
    assert.notEqual(data.user, SEEDED, '默认账户已被认领，不能再给第二个人');
  });

  test('新用户自动拿到初始文件夹，且按指定顺序', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    const { data } = await api('GET', '/api/folders', { xUserId: XID_B });
    assert.deepEqual(
      data.map((f) => f.name),
      ['文章', '想法', '观点', '建议'],
      '顺序要和产品约定一致'
    );
  });

  test('信息箱不是实体文件夹 —— 它是 folder_id 为 null 的虚拟桶', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    const { data } = await api('GET', '/api/folders', { xUserId: XID_B });
    assert.ok(!data.some((f) => f.name === '信息箱'), '建成实体行就意味着能被删，未归类的帖子会无处可去');

    // 不指定 folder_id 存进来的帖子，落在虚拟桶里
    await api('POST', '/api/posts', { body: post('inbox-check'), xUserId: XID_B });
    const posts = (await api('GET', '/api/posts', { xUserId: XID_B })).data;
    assert.equal(posts.find((p) => p.tweet_id === 'inbox-check').folder_id, null);
  });

  test('重复解析同一用户不会重复播种文件夹', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    await api('GET', '/health', { xUserId: XID_B });
    await api('GET', '/health', { xUserId: XID_B });
    const { data } = await api('GET', '/api/folders', { xUserId: XID_B });
    assert.equal(data.length, 4, `应该还是 4 个，实际 ${data.length} 个`);
  });

  test('两个账号的数据互相看不见', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    await api('POST', '/api/posts', { body: post('only-a'), xUserId: XID_A });
    await api('POST', '/api/posts', { body: post('only-b'), xUserId: XID_B });

    const a = (await api('GET', '/api/posts', { xUserId: XID_A })).data.map((p) => p.tweet_id);
    const b = (await api('GET', '/api/posts', { xUserId: XID_B })).data.map((p) => p.tweet_id);

    assert.ok(a.includes('only-a') && !a.includes('only-b'), 'A 不该看到 B 的');
    assert.ok(b.includes('only-b') && !b.includes('only-a'), 'B 不该看到 A 的');
  });

  test('同一个 X 账号再来还是同一个用户', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    const first = (await api('GET', '/health', { xUserId: XID_B })).data.user;
    const again = (await api('GET', '/health', { xUserId: XID_B })).data.user;
    assert.equal(first, again, '不能每次请求都新建用户');
  });

  test('改了 handle 后跟着更新，但仍是同一个用户', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    const before = (await api('GET', '/health', { xUserId: XID_B, handle: 'oldname' })).data.user;
    const after = (await api('GET', '/health', { xUserId: XID_B, handle: 'newname' })).data.user;
    assert.equal(before, after, 'handle 变了不能换用户 —— 主键是数字 ID');

    const c = await pg();
    const { rows } = await c.query('select x_handle from users where x_user_id = $1', [XID_B]);
    await c.end();
    assert.equal(rows[0].x_handle, 'newname', '可读信息应该跟上');
  });

  test('伪造的身份头被忽略，不会建出垃圾用户', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    for (const bad of ['abc', '../../etc', "1; drop table users", '']) {
      const { data } = await api('GET', '/health', { xUserId: bad });
      assert.equal(data.user, SEEDED, `非法 ID "${bad}" 应该退回默认账户`);
    }
  });

  test('非法 handle 不写进库', async (t) => {
    if (!ready) return t.skip('数据库不可用');
    await api('GET', '/health', { xUserId: XID_A, handle: '<script>alert(1)</script>' });
    const c = await pg();
    const { rows } = await c.query('select x_handle from users where x_user_id = $1', [XID_A]);
    await c.end();
    assert.equal(rows[0].x_handle, 'vica', '非法 handle 应该被丢弃，保留原值');
  });
});
