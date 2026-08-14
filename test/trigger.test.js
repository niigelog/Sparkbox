import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { matchTrigger } from '../src/content/trigger.js';
import { likeButtonReal, tweetWithButtons } from './fixtures/buttons.js';

function mount(html) {
  return new JSDOM(`<body>${html}</body>`, { url: 'https://x.com/home' }).window.document;
}

/** 模拟用户点在图标路径上（真实点击目标通常是 <path>，不是 button） */
function clickPathIn(doc, testid) {
  const path = doc.querySelector(`[data-testid="${testid}"] path`);
  assert.ok(path, `fixture 里应该有 ${testid} 的 path`);
  return matchTrigger(path);
}

describe('matchTrigger', () => {
  test('like（未点赞）触发保存，来源记为 like', () => {
    const hit = clickPathIn(mount(tweetWithButtons('like')), 'like');
    assert.ok(hit, 'closest() 应该能从 SVGElement 往上找到按钮');
    assert.equal(hit.kind, 'save');
    assert.equal(hit.source, 'like');
    assert.equal(hit.article.dataset.testid, 'tweet');
  });

  test('unlike 识别为撤销动作，来源指回 like', () => {
    const hit = clickPathIn(mount(tweetWithButtons('unlike')), 'unlike');
    assert.equal(hit?.kind, 'cancel');
    assert.equal(hit?.source, 'like');
  });

  test('bookmark 触发保存，来源记为 bookmark', () => {
    const hit = clickPathIn(mount(tweetWithButtons('bookmark')), 'bookmark');
    assert.equal(hit?.kind, 'save');
    assert.equal(hit?.source, 'bookmark');
  });

  test('removeBookmark 识别为撤销动作，来源指回 bookmark', () => {
    const hit = clickPathIn(mount(tweetWithButtons('removeBookmark')), 'removeBookmark');
    assert.equal(hit?.kind, 'cancel');
    assert.equal(hit?.source, 'bookmark');
  });

  test('同一条帖子里 like 和 unlike 并存时各自判断', () => {
    const doc = mount(tweetWithButtons('like', 'removeBookmark'));
    assert.equal(clickPathIn(doc, 'like')?.kind, 'save');
    assert.equal(clickPathIn(doc, 'removeBookmark')?.kind, 'cancel');
  });

  test('点在 button 本身也能匹配', () => {
    const doc = mount(tweetWithButtons('like'));
    assert.ok(matchTrigger(doc.querySelector('[data-testid="like"]')));
  });

  test('孤立的按钮（不在 article 里）不触发', () => {
    const doc = mount(likeButtonReal.replace('unlike', 'like'));
    assert.equal(matchTrigger(doc.querySelector('path')), null);
  });

  test('点在无关元素上返回 null', () => {
    const doc = mount(tweetWithButtons('like'));
    assert.equal(matchTrigger(doc.querySelector('[data-testid="tweetText"]')), null);
    assert.equal(matchTrigger(null), null);
  });
});
