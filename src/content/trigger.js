// X 的类名（css-146c3p1 / r-bcqeeo …）是 Emotion 生成的哈希，每次发版都变；
// aria-label 跟着界面语言变。data-testid 是唯一稳定的锚点。
//
// 按钮的 testid 表示的是「点下去会发生什么」，不是当前状态：
//   like   = 还没点赞，点下去是点赞  → 触发保存
//   unlike = 已经点赞了，点下去是取消 → 不保存
// 书签同理：bookmark 触发，removeBookmark 不触发。
const SAVES = {
  like: 'like',
  bookmark: 'bookmark',
};

// 取消动作映射回它撤销的那个来源
const CANCELS = {
  unlike: 'like',
  removeBookmark: 'bookmark',
};

const SELECTOR = [...Object.keys(SAVES), ...Object.keys(CANCELS)]
  .map((t) => `[data-testid="${t}"]`)
  .join(', ');

/**
 * 判断这次点击是「保存」还是「撤销保存」。
 * @param target 事件的 e.target —— 可能是按钮里的 <svg>/<path>，不是按钮本身
 * @returns {{ kind: 'save' | 'cancel', source: 'like' | 'bookmark', article: Element } | null}
 */
export function matchTrigger(target) {
  // SVGElement 也继承了 Element.closest，从 <path> 往上找不会断
  const btn = target?.closest?.(SELECTOR);
  if (!btn) return null;

  const testid = btn.dataset.testid;
  const kind = SAVES[testid] ? 'save' : CANCELS[testid] ? 'cancel' : null;
  if (!kind) return null;

  const article = btn.closest('article[data-testid="tweet"]');
  if (!article) return null;

  return { kind, source: SAVES[testid] ?? CANCELS[testid], article };
}
