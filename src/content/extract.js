// X 的 DOM 里，引用推文被包在 article 内部的 div[role="link"] 里。
// 直接 querySelector 会把引用推的正文/作者当成主推 —— 所有选择都要先排掉这块。
function inQuote(el, root) {
  const wrapper = el.closest('div[role="link"]');
  return !!wrapper && wrapper !== root && root.contains(wrapper);
}

function pick(root, selector) {
  for (const el of root.querySelectorAll(selector)) {
    if (!inQuote(el, root)) return el;
  }
  return null;
}

function pickAll(root, selector) {
  return Array.from(root.querySelectorAll(selector)).filter((el) => !inQuote(el, root));
}

// innerText 会丢掉 emoji（X 把 emoji 渲染成 <img alt="😀">），这里手动还原
function readText(el) {
  if (!el) return '';
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.nodeValue;
    else if (node.tagName === 'IMG') out += node.alt ?? '';
    else if (node.tagName === 'BR') out += '\n';
    else out += readText(node);
  }
  return out;
}

export function extractTweetId(root) {
  // 时间戳那个 <a> 才是帖子永久链接
  const timeEl = pick(root, 'time');
  const linkEl = timeEl?.closest('a[href*="/status/"]');
  if (linkEl) {
    // 注意 /status/123/photo/1 这类后缀，不能简单 split
    const id = linkEl.href.match(/\/status\/(\d+)/)?.[1];
    if (id) return { tweetId: id, permalink: `https://x.com/${new URL(linkEl.href).pathname.replace(/^\//, '').replace(/\/(photo|video|analytics).*$/, '')}` };
  }
  // 详情页的主帖没有这个链接，退回用当前 URL
  const fromUrl = location.pathname.match(/\/status\/(\d+)/)?.[1];
  if (fromUrl) return { tweetId: fromUrl, permalink: `https://x.com${location.pathname}` };
  return { tweetId: null, permalink: null };
}

function extractAuthor(root) {
  const userEl = pick(root, '[data-testid="User-Name"]');
  if (!userEl) return { authorHandle: null, authorName: null };

  // handle 从链接 path 里拿，比解析文本稳（User-Name 的文本是「名字 @handle · 2h」混合体）
  let authorHandle = null;
  let authorName = null;

  for (const a of userEl.querySelectorAll('a[href]')) {
    const seg = new URL(a.href, location.origin).pathname.match(/^\/([A-Za-z0-9_]{1,15})$/)?.[1];
    if (seg && !authorHandle) authorHandle = `@${seg}`;

    // 显示名和 @handle 指向同一个 href，只能靠文本区分；带 <time> 的是时间戳链接
    if (!authorName && !a.querySelector('time')) {
      const t = readText(a).trim();
      if (t && !t.startsWith('@')) authorName = t;
    }
  }
  return { authorHandle, authorName };
}

function extractMedia(root) {
  const urls = new Set();
  // 只取正文配图：头像走 /profile_images/，emoji 走 abs.twimg.com，都要排掉
  for (const img of pickAll(root, '[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media/"]')) {
    if (img.src.includes('/profile_images/')) continue;
    urls.add(img.src);
  }
  // <video> 的 src 是 blob:，存下来毫无意义，只能取封面图；
  // 真视频地址要走 API，留到后续版本。
  for (const video of pickAll(root, 'video')) {
    if (video.poster) urls.add(video.poster);
  }
  return Array.from(urls);
}

export function extractTweetData(root) {
  const { tweetId, permalink } = extractTweetId(root);
  const { authorHandle, authorName } = extractAuthor(root);

  return {
    tweetId,
    permalink,
    text: readText(pick(root, '[data-testid="tweetText"]')).trim(),
    authorHandle,
    authorName,
    mediaUrls: extractMedia(root),
    postedAt: pick(root, 'time')?.dateTime ?? null,
    savedAt: new Date().toISOString(),
    folderId: null,
  };
}
