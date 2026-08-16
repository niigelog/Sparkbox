/**
 * 对着真实 Postgres 跑完整的 HTTP 接口测试。
 *
 * 用一个随机 uuid 的临时用户跑，结束时物理删除该用户（外键 cascade 会带走它的所有数据），
 * 所以不会碰到默认用户的任何东西。
 *
 * 连不上数据库时整个文件跳过，不让没配库的环境挂在这里。
 */
import { test, describe, before, after, skip } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env')) process.loadEnvFile('.env');

const PORT = 7412;
const BASE = `http://192.168.101.12:${PORT}`;
const TEST_USER = randomUUID();
let proc;
let available = false;

const api = async (method, path, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: await res.json().catch(() => null) };
};

before(async () => {
  if (!process.env.APP_POSTGRES_HOST) return;

  // 先造出测试用户，否则 saved_posts.user_id 的外键过不去
  const pg = (await import('pg')).default;
  const client = new pg.Client({
    host: process.env.APP_POSTGRES_HOST,
    port: Number(process.env.APP_POSTGRES_PORT ?? 5432),
    database: process.env.APP_POSTGRES_DB,
    user: process.env.APP_POSTGRES_USER,
    password: process.env.APP_POSTGRES_PASSWORD,
    connectionTimeoutMillis: 5000,
  });
  try {
    await client.connect();
    await client.query(
      `insert into users (id, email, display_name) values ($1, $2, '接口测试用户')`,
      [TEST_USER, `test-${TEST_USER}@sparkbox.local`]
    );
    await client.end();
  } catch {
    return; // 连不上就跳过
  }

  proc = spawn('node', ['server/index.mjs'], {
    env: { ...process.env, PORT: String(PORT), APP_DEFAULT_USER_ID: TEST_USER },
    stdio: 'ignore',
  });

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) {
        available = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
});

after(async () => {
  proc?.kill();
  if (!process.env.APP_POSTGRES_HOST) return;
  const pg = (await import('pg')).default;
  const client = new pg.Client({
    host: process.env.APP_POSTGRES_HOST,
    port: Number(process.env.APP_POSTGRES_PORT ?? 5432),
    database: process.env.APP_POSTGRES_DB,
    user: process.env.APP_POSTGRES_USER,
    password: process.env.APP_POSTGRES_PASSWORD,
  });
  try {
    await client.connect();
    // 物理删除测试用户，folders / saved_posts 靠 on delete cascade 一起带走
    await client.query('delete from users where id = $1', [TEST_USER]);
    await client.end();
  } catch {}
});

const post = (tweetId, extra = {}) => ({
  tweet_id: tweetId,
  permalink: `https://x.com/a/status/${tweetId}`,
  author_handle: '@a',
  author_name: 'A',
  text_content: '正文 🚀',
  media_urls: [],
  posted_at: '2026-08-10T00:00:00.000Z',
  saved_at: `2026-08-1${tweetId}T00:00:00.000Z`,
  source: 'like',
  ...extra,
});

describe('API + Postgres 端到端', () => {
  test('健康检查', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const { status, data } = await api('GET', '/health');
    assert.equal(status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.user, TEST_USER, '必须跑在测试用户下，绝不能碰默认用户的数据');
  });

  test('新用户初始是空的', async (t) => {
    if (!available) return t.skip('数据库不可用');
    assert.deepEqual((await api('GET', '/api/posts')).data, []);
    assert.deepEqual((await api('GET', '/api/folders')).data, []);
  });

  test('存帖子 → 默认进信息箱（folder_id 为 null）', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const { status, data } = await api('POST', '/api/posts', post('1'));
    assert.equal(status, 200);
    assert.equal(data.folder_id, null);
    assert.equal(data.text_content, '正文 🚀');
    assert.deepEqual(data.media_urls, []);
  });

  test('重复存同一条走 upsert，不产生两条', async (t) => {
    if (!available) return t.skip('数据库不可用');
    await api('POST', '/api/posts', post('2', { text_content: '第一版' }));
    await api('POST', '/api/posts', post('2', { text_content: '第二版' }));
    const list = (await api('GET', '/api/posts')).data;
    const hits = list.filter((p) => p.tweet_id === '2');
    assert.equal(hits.length, 1);
    assert.equal(hits[0].text_content, '第二版');
  });

  test('重复收藏不会覆盖掉用户已做的归类', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const folder = (await api('POST', '/api/folders', { name: '归类保护' })).data;
    await api('POST', '/api/posts', post('3'));
    await api('PATCH', '/api/posts/3', { folder_id: folder.id });
    // 再次收藏（插件重推时会发生）
    await api('POST', '/api/posts', post('3'));

    const p = (await api('GET', '/api/posts')).data.find((x) => x.tweet_id === '3');
    assert.equal(p.folder_id, folder.id, '重推不该把帖子打回信息箱');
  });

  test('建文件夹返回 201，重名返回 409', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const a = await api('POST', '/api/folders', { name: '灵感素材' });
    assert.equal(a.status, 201);
    const b = await api('POST', '/api/folders', { name: '灵感素材' });
    assert.equal(b.status, 409);
    assert.match(b.data.error, /已经有叫/);
  });

  test('空白文件夹名被拒', async (t) => {
    if (!available) return t.skip('数据库不可用');
    assert.equal((await api('POST', '/api/folders', { name: '   ' })).status, 400);
  });

  test('移动到不存在的文件夹被拒，而不是写进脏数据', async (t) => {
    if (!available) return t.skip('数据库不可用');
    await api('POST', '/api/posts', post('4'));
    const res = await api('PATCH', '/api/posts/4', { folder_id: randomUUID() });
    assert.equal(res.status, 400);
  });

  test('folder_id 传空字符串 = 移回信息箱', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const folder = (await api('POST', '/api/folders', { name: '临时归类' })).data;
    await api('POST', '/api/posts', post('5'));
    await api('PATCH', '/api/posts/5', { folder_id: folder.id });
    const back = await api('PATCH', '/api/posts/5', { folder_id: '' });
    assert.equal(back.data.folder_id, null);
  });

  test('删文件夹：帖子回信息箱，不被连带删除', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const folder = (await api('POST', '/api/folders', { name: '待删除' })).data;
    await api('POST', '/api/posts', post('6'));
    await api('PATCH', '/api/posts/6', { folder_id: folder.id });

    const del = await api('DELETE', `/api/folders/${folder.id}`);
    assert.equal(del.status, 200);
    assert.equal(del.data.moved, 1);

    const folders = (await api('GET', '/api/folders')).data;
    assert.ok(!folders.some((f) => f.id === folder.id));

    const p = (await api('GET', '/api/posts')).data.find((x) => x.tweet_id === '6');
    assert.ok(p, '帖子不该被删');
    assert.equal(p.folder_id, null);
  });

  test('删帖子是幂等的（重试队列的前提）', async (t) => {
    if (!available) return t.skip('数据库不可用');
    await api('POST', '/api/posts', post('7'));
    const first = await api('DELETE', '/api/posts/7');
    const second = await api('DELETE', '/api/posts/7');
    assert.equal(first.status, 200);
    assert.equal(second.status, 200, '删两次都必须成功，否则插件会无限重试');
    assert.equal(first.data.deleted, 1);
    assert.equal(second.data.deleted, 0);
  });

  test('删掉后可以重新收藏（软删除不占用唯一键）', async (t) => {
    if (!available) return t.skip('数据库不可用');
    await api('POST', '/api/posts', post('8'));
    await api('DELETE', '/api/posts/8');
    const again = await api('POST', '/api/posts', post('8', { text_content: '又存回来了' }));
    assert.equal(again.status, 200);

    const list = (await api('GET', '/api/posts')).data.filter((p) => p.tweet_id === '8');
    assert.equal(list.length, 1);
    assert.equal(list[0].text_content, '又存回来了');
  });

  test('列表按 saved_at 倒序', async (t) => {
    if (!available) return t.skip('数据库不可用');
    const list = (await api('GET', '/api/posts')).data;
    const times = list.map((p) => new Date(p.saved_at).getTime());
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  test('缺必填字段返回 400 而不是 500', async (t) => {
    if (!available) return t.skip('数据库不可用');
    assert.equal((await api('POST', '/api/posts', { permalink: 'x' })).status, 400);
    assert.equal((await api('POST', '/api/posts', { tweet_id: '9' })).status, 400);
  });

  test('非法 uuid 返回 400 而不是 500', async (t) => {
    if (!available) return t.skip('数据库不可用');
    assert.equal((await api('DELETE', '/api/folders/not-a-uuid')).status, 400);
    assert.equal((await api('PATCH', '/api/folders/not-a-uuid', { name: 'x' })).status, 400);
  });

  test('未知路由返回 404', async (t) => {
    if (!available) return t.skip('数据库不可用');
    assert.equal((await api('GET', '/api/nope')).status, 404);
  });
});
