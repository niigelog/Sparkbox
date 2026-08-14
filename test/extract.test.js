import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { tweetWithQuote, plainTweet, videoTweet } from './fixtures/tweet.js';

let extractTweetData;

function mount(html, url = 'https://x.com/home') {
  const dom = new JSDOM(`<body>${html}</body>`, { url });
  // extract.js 直接引用全局 Node / location，这里补上
  globalThis.Node = dom.window.Node;
  globalThis.location = { origin: dom.window.location.origin, pathname: dom.window.location.pathname };
  return dom.window.document.querySelector('article');
}

before(async () => {
  // 先建一个最小 DOM 环境，再导入模块
  mount('');
  ({ extractTweetData } = await import('../src/content/extract.js'));
});

describe('extractTweetData', () => {
  test('tweetId 不被 /photo/1 后缀污染', () => {
    const post = extractTweetData(mount(tweetWithQuote));
    assert.equal(post.tweetId, '1234567890');
    assert.equal(post.permalink, 'https://x.com/elonmusk/status/1234567890');
  });

  test('正文取主推，不取引用推', () => {
    const post = extractTweetData(mount(tweetWithQuote));
    assert.match(post.text, /主推文正文/);
    assert.doesNotMatch(post.text, /被引用的推文/);
  });

  test('emoji 被还原进正文', () => {
    const post = extractTweetData(mount(tweetWithQuote));
    assert.equal(post.text, '这是主推文正文 🚀 结束');
  });

  test('作者取主推作者，handle 与显示名拆开', () => {
    const post = extractTweetData(mount(tweetWithQuote));
    assert.equal(post.authorHandle, '@elonmusk');
    assert.equal(post.authorName, 'Elon Musk');
  });

  test('媒体排除头像和引用推配图', () => {
    const post = extractTweetData(mount(tweetWithQuote));
    assert.equal(post.mediaUrls.length, 1);
    assert.match(post.mediaUrls[0], /media\/AAA111/);
    assert.ok(!post.mediaUrls.some((u) => u.includes('profile_images')));
    assert.ok(!post.mediaUrls.some((u) => u.includes('QUOTE999')));
  });

  test('时间取主推的，不取引用推的', () => {
    const post = extractTweetData(mount(tweetWithQuote));
    assert.equal(post.postedAt, '2026-08-10T09:30:00.000Z');
  });

  test('无图帖：<br> 转换成换行，媒体为空', () => {
    const post = extractTweetData(mount(plainTweet));
    assert.equal(post.tweetId, '9876543210');
    assert.equal(post.text, '第一行\n第二行');
    assert.deepEqual(post.mediaUrls, []);
  });

  test('作者显示名里的 emoji 不丢', () => {
    const post = extractTweetData(mount(plainTweet));
    assert.equal(post.authorName, 'Naval🧠');
    assert.equal(post.authorHandle, '@naval');
  });

  test('视频帖只取 poster，不取 blob: 地址', () => {
    const post = extractTweetData(mount(videoTweet));
    assert.deepEqual(post.mediaUrls, [
      'https://pbs.twimg.com/ext_tw_video_thumb/555/img/poster.jpg',
    ]);
  });

  test('详情页主帖没有时间戳链接时，回退到当前 URL', () => {
    const detail = `
      <article data-testid="tweet">
        <div data-testid="User-Name"><a href="/vica"><span>Vica</span></a></div>
        <div data-testid="tweetText">详情页主帖</div>
        <time datetime="2026-08-14T01:00:00.000Z">1h</time>
      </article>`;
    const post = extractTweetData(mount(detail, 'https://x.com/vica/status/4242424242'));
    assert.equal(post.tweetId, '4242424242');
    assert.equal(post.permalink, 'https://x.com/vica/status/4242424242');
  });
});
