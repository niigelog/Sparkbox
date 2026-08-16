import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let server;
let received = [];
let respond = { status: 200, body: '{"ok":true}' };
let pushPost;

const samplePost = {
  tweetId: '1234567890',
  permalink: 'https://x.com/elonmusk/status/1234567890',
  authorHandle: '@elonmusk',
  authorName: 'Elon Musk',
  text: '正文 🚀',
  mediaUrls: ['https://pbs.twimg.com/media/AAA111'],
  postedAt: '2026-08-10T09:30:00.000Z',
  savedAt: '2026-08-14T02:00:00.000Z',
  folderId: null,
  source: 'like',
};

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(respond.status, { 'content-type': 'application/json' });
      res.end(respond.body);
    });
  });
  await new Promise((r) => server.listen(0, '192.168.101.12', r));

  // 模拟 esbuild 的构建时注入
  globalThis.__SYNC_ENDPOINT__ = `http://192.168.101.12:${server.address().port}/api/posts`;
  ({ pushPost } = await import('../src/background/sinks/local.js'));
});

after(() => server?.close());

describe('local sink', () => {
  test('POST 到配置的接口，payload 字段名对齐 schema', async () => {
    received = [];
    respond = { status: 200, body: '{"ok":true}' };
    await pushPost(samplePost);

    assert.equal(received.length, 1);
    const req = received[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.url, '/api/posts');
    assert.match(req.headers['content-type'], /application\/json/);

    assert.deepEqual(JSON.parse(req.body), {
      tweet_id: '1234567890',
      permalink: 'https://x.com/elonmusk/status/1234567890',
      author_handle: '@elonmusk',
      author_name: 'Elon Musk',
      text_content: '正文 🚀',
      media_urls: ['https://pbs.twimg.com/media/AAA111'],
      posted_at: '2026-08-10T09:30:00.000Z',
      folder_id: null, // null = 信息箱
      source: 'like',
      saved_at: '2026-08-14T02:00:00.000Z',
    });
  });

  test('撤销走 DELETE {endpoint}/{tweet_id}', async () => {
    received = [];
    respond = { status: 200, body: '{"ok":true}' };
    const { deletePost } = await import('../src/background/sinks/local.js');
    await deletePost(samplePost);

    assert.equal(received.length, 1);
    assert.equal(received[0].method, 'DELETE');
    assert.equal(received[0].url, '/api/posts/1234567890');
  });

  test('4xx/5xx 抛错，让 queue 保持 pending 等重试', async () => {
    received = [];
    respond = { status: 500, body: 'boom' };
    await assert.rejects(() => pushPost(samplePost), /HTTP 500 boom/);
  });

  test('服务没起来时报 Failed to fetch（queue 认这个前缀中断本轮）', async () => {
    const saved = globalThis.__SYNC_ENDPOINT__;
    // ENDPOINT 在模块加载时就读死了，换 query 拿一份新的模块实例
    globalThis.__SYNC_ENDPOINT__ = 'http://192.168.101.12:1/api/posts'; // 确定没人监听
    const { pushPost: deadPush } = await import('../src/background/sinks/local.js?v=dead');
    globalThis.__SYNC_ENDPOINT__ = saved;

    await assert.rejects(() => deadPush(samplePost), /Failed to fetch/);
  });
});
