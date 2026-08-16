/**
 * 接口契约测试：用**插件自己的 sink 代码**去打真实 API 服务。
 *
 * 和 test/api.test.js 的分工：那个测 HTTP 层的状态码和参数校验，
 * 这个测「插件客户端 ↔ 服务端」的字段映射对不对得上（tweet_id ↔ tweetId 这类）。
 *
 * 用随机 uuid 的临时用户，跑完物理删除，不碰真实收藏。连不上数据库时跳过。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

if (existsSync('.env')) process.loadEnvFile('.env');

async function waitFor(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  return false;
}

async function pgClient() {
  const pg = (await import('pg')).default;
  const c = new pg.Client({
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

const backends = [
  {
    name: 'server（Postgres）',
    port: 7314,
    async start(port) {
      if (!process.env.APP_POSTGRES_HOST) return { up: false, stop: () => {} };

      const userId = randomUUID();
      let client;
      try {
        client = await pgClient();
        await client.query(
          `insert into users (id, email, display_name) values ($1, $2, '契约测试用户')`,
          [userId, `contract-${userId}@sparkbox.local`]
        );
        await client.end();
      } catch {
        return { up: false, stop: () => {} }; // 连不上就跳过这一轮
      }

      const proc = spawn('node', ['server/index.mjs'], {
        env: { ...process.env, PORT: String(port), APP_DEFAULT_USER_ID: userId },
        stdio: 'ignore',
      });
      const up = await waitFor(`http://192.168.101.12:${port}/health`);
      return {
        up,
        async stop() {
          proc.kill();
          try {
            const c = await pgClient();
            // 外键 cascade 会带走这个用户的所有 folders / saved_posts
            await c.query('delete from users where id = $1', [userId]);
            await c.end();
          } catch {}
        },
      };
    },
  },
];

const samplePost = (tweetId, extra = {}) => ({
  tweetId,
  permalink: `https://x.com/a/status/${tweetId}`,
  authorHandle: '@a',
  authorName: 'A',
  text: '正文 🚀',
  mediaUrls: [],
  postedAt: '2026-08-10T00:00:00.000Z',
  savedAt: `2026-08-1${tweetId}T00:00:00.000Z`,
  source: 'like',
  ...extra,
});

for (const [i, backend] of backends.entries()) {
  describe(`接口契约 · ${backend.name}`, () => {
    let handle;
    let sink;
    let ready = false;

    before(async () => {
      handle = await backend.start(backend.port);
      if (!handle.up) return;
      // sink 在模块加载时读死 endpoint，换 query 拿独立实例
      globalThis.__SYNC_ENDPOINT__ = `http://192.168.101.12:${backend.port}/api/posts`;
      sink = await import(`../src/background/sinks/local.js?backend=${i}`);
      ready = true;
    });

    after(async () => handle?.stop());

    test('新建文件夹后能读回来', async (t) => {
      if (!ready) return t.skip('后端不可用');
      const created = await sink.createFolder('灵感素材');
      assert.ok(created.id, '必须返回 id');
      assert.equal(created.name, '灵感素材');
      assert.ok((await sink.fetchFolders()).some((f) => f.id === created.id));
    });

    test('重命名生效', async (t) => {
      if (!ready) return t.skip('后端不可用');
      const f = await sink.createFolder('待读');
      await sink.renameFolder(f.id, '稍后再读');
      assert.equal((await sink.fetchFolders()).find((x) => x.id === f.id)?.name, '稍后再读');
    });

    test('推上去的帖子默认在信息箱，字段映射正确', async (t) => {
      if (!ready) return t.skip('后端不可用');
      await sink.pushPost(samplePost('1'));
      const p = (await sink.fetchPosts()).find((x) => x.tweetId === '1');
      assert.ok(p, '应该能读回来');
      assert.equal(p.folderId, null, 'null = 信息箱');
      assert.equal(p.text, '正文 🚀', 'text_content → text');
      assert.equal(p.authorHandle, '@a');
      assert.equal(p.source, 'like');
      assert.deepEqual(p.mediaUrls, []);
    });

    test('移动到文件夹后 folderId 跟着变', async (t) => {
      if (!ready) return t.skip('后端不可用');
      const f = await sink.createFolder('技术');
      await sink.pushPost(samplePost('2'));
      await sink.movePost('2', f.id);
      assert.equal((await sink.fetchPosts()).find((x) => x.tweetId === '2')?.folderId, f.id);
    });

    test('删除文件夹时帖子回信息箱，不被连带删除', async (t) => {
      if (!ready) return t.skip('后端不可用');
      const f = await sink.createFolder('临时');
      await sink.pushPost(samplePost('3'));
      await sink.movePost('3', f.id);
      await sink.deleteFolder(f.id);

      assert.ok(!(await sink.fetchFolders()).some((x) => x.id === f.id), '文件夹应该没了');
      const p = (await sink.fetchPosts()).find((x) => x.tweetId === '3');
      assert.ok(p, '帖子不该被连带删除');
      assert.equal(p.folderId, null, '应该回到信息箱');
    });

    test('重复推同一条走 upsert，不产生两条', async (t) => {
      if (!ready) return t.skip('后端不可用');
      await sink.pushPost(samplePost('4', { text: '第一版' }));
      await sink.pushPost(samplePost('4', { text: '第二版' }));
      const hits = (await sink.fetchPosts()).filter((x) => x.tweetId === '4');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].text, '第二版');
    });

    test('重复收藏不覆盖已做的归类', async (t) => {
      if (!ready) return t.skip('后端不可用');
      const f = await sink.createFolder('归类保护');
      await sink.pushPost(samplePost('5'));
      await sink.movePost('5', f.id);
      await sink.pushPost(samplePost('5')); // 插件重推

      const p = (await sink.fetchPosts()).find((x) => x.tweetId === '5');
      assert.equal(p.folderId, f.id, '重推不该把帖子打回信息箱');
    });

    test('列表按收藏时间倒序', async (t) => {
      if (!ready) return t.skip('后端不可用');
      const times = (await sink.fetchPosts()).map((p) => new Date(p.savedAt).getTime());
      assert.deepEqual(times, [...times].sort((a, b) => b - a));
    });

    test('删除帖子是幂等的', async (t) => {
      if (!ready) return t.skip('后端不可用');
      await sink.pushPost(samplePost('6'));
      await sink.deletePost({ tweetId: '6' });
      await sink.deletePost({ tweetId: '6' }); // 不该抛错，否则队列无限重试
      assert.ok(!(await sink.fetchPosts()).some((x) => x.tweetId === '6'));
    });

    test('删掉后可以重新收藏', async (t) => {
      if (!ready) return t.skip('后端不可用');
      await sink.pushPost(samplePost('7'));
      await sink.deletePost({ tweetId: '7' });
      await sink.pushPost(samplePost('7', { text: '又存回来了' }));

      const hits = (await sink.fetchPosts()).filter((x) => x.tweetId === '7');
      assert.equal(hits.length, 1);
      assert.equal(hits[0].text, '又存回来了');
    });
  });
}
