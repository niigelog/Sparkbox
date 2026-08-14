import { pushPost, deletePost, fetchPosts, setActor } from '#sink';
import { shouldRemove, KEEP_REASONS } from '../shared/removal.js';

/**
 * Service Worker：只做内容脚本做不了的事 —— 接页面消息、跨域写后端、操作标签页。
 *
 * 没有本地缓存层。收藏动作直接写后端，成败如实返回给页面。
 * 代价是后端没起来时这次点击会丢（会弹明确的失败提示），
 * 换来的是链路上少一个会坏的环节。
 */

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(console.error);
});

/**
 * 通知已打开的侧边栏「数据变了，去重新拉一次」。
 *
 * 这样侧边栏就不用定时轮询 —— 轮询不但白跑查询，还会每隔几秒把 SW 唤醒一次，
 * 让它永远休眠不了。没有面板打开时 sendMessage 会 reject，忽略即可。
 */
function notifyPanel() {
  chrome.runtime.sendMessage({ type: 'DATA_CHANGED' }).catch(() => {});
}

/** 后端连不上时给一句能直接照做的提示，而不是把 fetch 的原始错误甩出去 */
function friendly(err) {
  const msg = String(err?.message ?? err);
  if (/Failed to fetch/i.test(msg)) return '后端没有响应，确认服务已启动（npm run server）';
  return msg;
}

const handlers = {
  async SAVE_POST({ actor, ...payload }) {
    setActor(actor);
    await pushPost(payload);
    notifyPanel();
    return { ok: true, tweetId: payload.tweetId };
  },

  /**
   * 撤销保存。后端才是数据源，所以先问它这条现在长什么样，
   * 只撤销「还没动过」的 —— 已经归类或加过备注的保留。
   */
  async REMOVE_POST({ tweetId, source }) {
    const posts = await fetchPosts();
    const record = posts.find((p) => p.tweetId === tweetId);

    const verdict = shouldRemove(record, source);
    if (!verdict.remove) {
      return {
        ok: true,
        removed: false,
        reason: verdict.reason,
        message: KEEP_REASONS[verdict.reason],
      };
    }

    await deletePost({ tweetId });
    notifyPanel();
    return { ok: true, removed: true, reason: verdict.reason };
  },

};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const handler = handlers[message?.type];
  if (!handler) {
    console.warn('[sparkbox] 未知消息类型', message?.type);
    return false;
  }
  if (__DEBUG__) console.log('[sparkbox bg] 收到', message.type, message.payload);

  handler(message.payload).then(sendResponse, (err) => {
    console.error('[sparkbox bg]', message.type, err);
    sendResponse({ ok: false, error: friendly(err) });
  });
  return true; // 保持消息通道开着，等异步 sendResponse
});

if (__DEBUG__) console.log('[sparkbox bg] service worker 已启动');
