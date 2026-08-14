// 直接加载 dist/content.js（打包后的真实产物）在仿真页面里跑一遍完整点击流程。
// 前面的测试测的是源码模块，这个测的是最终装进 Chrome 的那个文件 ——
// 能抓到 define 替换失败、模块初始化报错、监听器没注册上这类问题。
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tweetWithButtons, SIDEBAR } from './fixtures/buttons.js';

const BUNDLE = 'dist/content.js';
let code;

before(async () => {
  assert.ok(existsSync(BUNDLE), `${BUNDLE} 不存在，先跑 npm run build`);
  code = await readFile(BUNDLE, 'utf8');
});

/** 起一个带 chrome stub 的页面，把打包产物注进去 */
function boot(html, url = 'https://x.com/home') {
  const dom = new JSDOM(`<body>${html}</body>`, { url, runScripts: 'outside-only' });
  const sent = [];
  const listeners = [];
  dom.window.chrome = {
    runtime: {
      lastError: null,
      sendMessage(msg, cb) {
        sent.push(msg);
        cb?.({ ok: true, tweetId: msg.payload?.tweetId });
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener: (fn) => listeners.push(fn) },
    },
  };
  // 模拟 background 往内容脚本发消息
  const dispatch = (msg) =>
    new Promise((resolve) => {
      for (const fn of listeners) fn(msg, {}, resolve);
    });
  const logs = [];
  dom.window.console = { ...console, log: (...a) => logs.push(a.join(' ')) };

  dom.window.eval(code); // content.js 是 IIFE，直接执行
  return { dom, sent, logs, dispatch };
}

function clickPath(dom, testid) {
  const path = dom.window.document.querySelector(`[data-testid="${testid}"] path`);
  assert.ok(path, `找不到 ${testid} 的 path`);
  path.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
}

describe('dist/content.js 打包产物', () => {
  test('加载时不报错，且打出注入日志', () => {
    const { logs } = boot(tweetWithButtons('like'));
    assert.ok(
      logs.some((l) => l.includes('content script 已注入')),
      `没看到注入日志，实际输出: ${JSON.stringify(logs)}`
    );
  });

  test('__DEBUG__ 被构建时替换掉了，没有残留', () => {
    assert.ok(!code.includes('__DEBUG__'), 'bundle 里还有未替换的 __DEBUG__');
    assert.ok(!code.includes('__SYNC_ENDPOINT__'), 'bundle 里还有未替换的占位符');
  });

  test('点 like 的图标 → 发出 SAVE_POST', () => {
    const { dom, sent } = boot(tweetWithButtons('like'));
    clickPath(dom, 'like');

    assert.equal(sent.length, 1, '应该只发一条消息');
    assert.equal(sent[0].type, 'SAVE_POST');
    assert.equal(sent[0].payload.source, 'like');
    assert.equal(sent[0].payload.tweetId, '1111111111');
    assert.equal(sent[0].payload.text, '正文');
    assert.equal(sent[0].payload.authorHandle, '@vica');
  });

  test('点 unlike → 发出 REMOVE_POST 而不是保存', () => {
    const { dom, sent } = boot(tweetWithButtons('unlike'));
    clickPath(dom, 'unlike');

    assert.equal(sent.length, 1);
    assert.equal(sent[0].type, 'REMOVE_POST');
    assert.equal(sent[0].payload.tweetId, '1111111111');
    assert.equal(sent[0].payload.source, 'like'); // unlike 撤销的是 like
  });

  test('点 removeBookmark → REMOVE_POST，来源指回 bookmark', () => {
    const { dom, sent } = boot(tweetWithButtons('removeBookmark'));
    clickPath(dom, 'removeBookmark');
    assert.equal(sent[0]?.type, 'REMOVE_POST');
    assert.equal(sent[0]?.payload.source, 'bookmark');
  });

  test('撤销后可以立刻重新点赞存回来（防抖被清掉）', () => {
    const { dom, sent } = boot(tweetWithButtons('like', 'unlike'));
    clickPath(dom, 'like');
    clickPath(dom, 'unlike');
    clickPath(dom, 'like');

    assert.deepEqual(
      sent.map((m) => m.type),
      ['SAVE_POST', 'REMOVE_POST', 'SAVE_POST']
    );
  });

  test('3 秒内连点同一条只发一次', () => {
    const { dom, sent } = boot(tweetWithButtons('like'));
    clickPath(dom, 'like');
    clickPath(dom, 'like');
    clickPath(dom, 'like');
    assert.equal(sent.length, 1);
  });

  test('页面上有侧边栏时，带上当前 X 用户一起发', () => {
    // 之前的 fixture 里没有侧边栏，readCurrentUser 那条路径从没被真正执行过
    const { dom, sent } = boot(SIDEBAR + tweetWithButtons('like'));
    clickPath(dom, 'like');

    assert.equal(sent.length, 1, '收藏必须照常发出去');
    assert.equal(sent[0].type, 'SAVE_POST');
    assert.equal(sent[0].payload.actor?.handle, 'vica', '应该读到当前登录用户');
  });

  test('读不到当前用户也绝不能挡住收藏', () => {
    // 窄屏/改版时侧边栏可能整个不存在
    const { dom, sent } = boot(tweetWithButtons('like'));
    clickPath(dom, 'like');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].payload.actor?.handle, null);
  });

  test('个人资料链接畸形时不能抛错', () => {
    const broken = `<a href="" role="link" data-testid="AppTabBar_Profile_Link"></a>`;
    const { dom, sent } = boot(broken + tweetWithButtons('like'));
    assert.doesNotThrow(() => clickPath(dom, 'like'));
    assert.equal(sent.length, 1, '身份读取失败不能连累收藏');
  });

  test('点 bookmark → source 记为 bookmark', () => {
    const { dom, sent } = boot(tweetWithButtons('bookmark'));
    clickPath(dom, 'bookmark');
    assert.equal(sent[0]?.payload.source, 'bookmark');
  });

});
