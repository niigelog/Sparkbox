#!/usr/bin/env node
/**
 * 全链路冒烟：模拟插件在 X 上点一次 ❤️，一路走到 Postgres 再读回来。
 * 用的是插件自己的 sink 代码和真实 API 服务，只差一个浏览器。
 *
 *   npm run smoke        # 需要 npm run server 已经起着
 *
 * 结束会把造的数据清掉。
 */
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const ENDPOINT = process.env.SYNC_ENDPOINT ?? 'http://192.168.101.12:7000/api/posts';
const BASE = ENDPOINT.replace(/\/posts\/?$/, '');
globalThis.__SYNC_ENDPOINT__ = ENDPOINT;

const sink = await import('../src/background/sinks/local.js');

const step = (n, msg) => console.log(`\n${n}. ${msg}`);
const ok = (msg) => console.log(`   ✔ ${msg}`);
const fail = (msg) => {
  console.error(`   ✖ ${msg}`);
  process.exitCode = 1;
};

// 插件在页面上抓到的东西长这样（extract.js 的输出 + trigger.js 给的 source）
const TWEET_ID = `smoke-${Date.now()}`;
const captured = {
  tweetId: TWEET_ID,
  permalink: `https://x.com/sparkbox/status/${TWEET_ID}`,
  authorHandle: '@sparkbox',
  authorName: '冒烟测试🚀',
  text: '第一行\n第二行 🎉',
  mediaUrls: ['https://pbs.twimg.com/media/SMOKE?format=jpg'],
  postedAt: '2026-08-14T00:00:00.000Z',
  savedAt: new Date().toISOString(),
  folderId: null,
  source: 'like',
};

console.log(`\n目标 ${BASE}`);

try {
  await fetch(`${BASE.replace(/\/api$/, '')}/health`).catch(() => null);
} catch {}

step(1, '模拟点击 ❤️ → 推送到后端');
try {
  await sink.pushPost(captured);
  ok('推送成功');
} catch (e) {
  fail(`推送失败：${e.message}`);
  console.error('\n   后端没起来？先跑 npm run server\n');
  process.exit(1);
}

step(2, '按侧边栏的方式读回来');
let post = (await sink.fetchPosts()).find((p) => p.tweetId === TWEET_ID);
if (!post) fail('读不到刚存的帖子');
else {
  const checks = [
    ['正文含换行', post.text === '第一行\n第二行 🎉'],
    ['emoji 没丢', post.authorName === '冒烟测试🚀'],
    ['handle 正确', post.authorHandle === '@sparkbox'],
    ['媒体是数组', Array.isArray(post.mediaUrls) && post.mediaUrls.length === 1],
    ['原帖时间保留', new Date(post.postedAt).toISOString() === '2026-08-14T00:00:00.000Z'],
    ['默认进信息箱', post.folderId === null],
    ['来源记为 like', post.source === 'like'],
  ];
  for (const [name, pass] of checks) (pass ? ok : fail)(name);
}

step(3, '新建文件夹并移动进去');
const folderName = `冒烟-${Date.now()}`;
const folder = await sink.createFolder(folderName);
ok(`建了「${folder.name}」`);
await sink.movePost(TWEET_ID, folder.id);
post = (await sink.fetchPosts()).find((p) => p.tweetId === TWEET_ID);
post?.folderId === folder.id ? ok('移动生效') : fail('移动没生效');

step(4, '再次收藏同一条（模拟插件重推）');
await sink.pushPost(captured);
post = (await sink.fetchPosts()).find((p) => p.tweetId === TWEET_ID);
post?.folderId === folder.id ? ok('归类没被冲掉') : fail('重推把帖子打回信息箱了');
const dupes = (await sink.fetchPosts()).filter((p) => p.tweetId === TWEET_ID).length;
dupes === 1 ? ok('没有产生重复记录') : fail(`产生了 ${dupes} 条重复`);

step(5, '删除文件夹 → 帖子应回信息箱');
await sink.deleteFolder(folder.id);
post = (await sink.fetchPosts()).find((p) => p.tweetId === TWEET_ID);
if (!post) fail('帖子被连带删除了');
else post.folderId === null ? ok('回到信息箱') : fail('folder_id 没置空');

step(6, '模拟取消点赞 → 删除（并验证幂等）');
await sink.deletePost({ tweetId: TWEET_ID });
await sink.deletePost({ tweetId: TWEET_ID });
ok('删两次都没报错');
(await sink.fetchPosts()).some((p) => p.tweetId === TWEET_ID)
  ? fail('删完还在')
  : ok('已从列表消失');

const remaining = await sink.fetchPosts();
console.log(
  `\n${process.exitCode ? '有检查未通过' : '全链路通畅'}　库里现存 ${remaining.length} 条真实数据\n`
);
