import { extractTweetData, extractTweetId } from './extract.js';
import { matchTrigger } from './trigger.js';
import { readCurrentUser } from './whoami.js';
import { showToast } from './toast.js';

const DEBUG = __DEBUG__;
const log = (...args) => DEBUG && console.log('%c[sparkbox]', 'color:#1d9bf0', ...args);

// 注入成功的信号：这行不出现，说明 content script 根本没跑起来
log('content script 已注入', location.href);

const recent = new Map(); // tweetId -> 时间戳，防连点重复发送
const DEDUPE_MS = 3000;

/** 把点击目标往上的 data-testid 链打出来，用于核对 X 真实的按钮标识 */
function testidChain(target) {
  const chain = [];
  for (let n = target; n && n !== document; n = n.parentElement) {
    if (n.dataset?.testid) chain.push(n.dataset.testid);
  }
  return chain;
}

// 用捕获阶段：X 是 React 应用，点击后会把 data-testid 从 bookmark 改成 removeBookmark，
// 冒泡阶段再读就已经变了，分不清这次是「收藏」还是「取消收藏」。
document.addEventListener(
  'click',
  (e) => {
    if (DEBUG) {
      const chain = testidChain(e.target);
      if (chain.length) log('点击命中', chain.join(' ← '));
    }

    const hit = matchTrigger(e.target);
    if (!hit) return;

    if (hit.kind === 'cancel') {
      handleCancel(hit);
      return;
    }

    log(`识别为保存动作（来源 ${hit.source}），开始提取`);
    const post = { ...extractTweetData(hit.article), source: hit.source };
    // 顺带把「现在登录 X 的是谁」带上，服务端据此归属数据
    const actor = readCurrentUser();
    log('提取结果', post);

    if (!post.tweetId) {
      console.warn('[sparkbox] 抓不到 tweetId，跳过。article:', hit.article);
      showToast('抓取失败：找不到帖子 ID', 'error');
      return;
    }

    const now = Date.now();
    const last = recent.get(post.tweetId);
    if (last && now - last < DEDUPE_MS) {
      log('短时间内重复点击，跳过', post.tweetId);
      return;
    }
    recent.set(post.tweetId, now);

    chrome.runtime.sendMessage({ type: 'SAVE_POST', payload: { ...post, actor } }, (res) => {
      // 没有本地缓存兜底了：失败就是真丢了，所以要让用户能立刻重点一次
      const failed = (reason) => {
        recent.delete(post.tweetId);
        console.error('[sparkbox] 保存失败:', reason);
        showToast(`保存失败：${reason}`, 'error');
      };

      if (chrome.runtime.lastError) {
        return failed('扩展后台未响应，去 chrome://extensions 刷新一下');
      }
      if (!res?.ok) return failed(res?.error ?? '未知原因');

      log('已保存', res.tweetId);
      showToast('已收藏到信息箱');
    });
  },
  true
);

/** 取消点赞/取消收藏：只撤销还没动过的那条，判断在 background 做 */
function handleCancel(hit) {
  const { tweetId } = extractTweetId(hit.article);
  if (!tweetId) return;

  log(`识别为撤销动作（来源 ${hit.source}）`, tweetId);
  recent.delete(tweetId); // 撤销后允许立刻重新存

  chrome.runtime.sendMessage(
    { type: 'REMOVE_POST', payload: { tweetId, source: hit.source } },
    (res) => {
      if (chrome.runtime.lastError) {
        console.error('[sparkbox] 发消息失败:', chrome.runtime.lastError.message);
        return;
      }
      log('撤销结果', res);
      if (res?.removed) showToast('已从信息箱移除');
      else if (res?.reason && res.reason !== 'not-found') showToast(res.message ?? '已保留');
    }
  );
}

// TODO: X 的键盘快捷键 b 也能收藏，走的不是 click，当前抓不到
