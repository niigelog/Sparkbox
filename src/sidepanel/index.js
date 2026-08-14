import { INBOX_NAME, isInbox } from '../shared/constants.js';
import {
  fetchPosts,
  fetchFolders,
  createFolder as apiCreateFolder,
  renameFolder as apiRenameFolder,
  deleteFolder as apiDeleteFolder,
  movePost as apiMovePost,
  deletePost as apiDeletePost,
} from '#sink';

/**
 * 侧边栏直接读后端接口，不经过 Service Worker。
 *
 * MV3 的 SW 随时会被回收，唤不醒的时候整个面板就瞎了 —— 之前就是这样。
 * 侧边栏本身是扩展页面，有 host 权限，能直接 fetch。
 * SW 只保留它独有的职责：接内容脚本的消息、跨域写后端。
 */

const listEl = document.getElementById('list');
const bannerEl = document.getElementById('banner');
const folderSel = document.getElementById('folder');
const newFolderBtn = document.getElementById('new-folder');
const renameBtn = document.getElementById('rename-folder');
const delFolderBtn = document.getElementById('del-folder');
const progressEl = document.getElementById('progress');

// 内联 SVG：扩展的 CSP 禁止外部资源，图标字体和远程图片都加载不了。
// 这是写死的常量字符串，不含任何用户数据。
const TRASH_ICON = `<svg viewBox="0 0 24 24" width="15" height="15" fill="none"
  stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"
  aria-hidden="true"><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/><path
  d="M6 7v12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7"/><path d="M10 11v6M14 11v6"/></svg>`;

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text != null) n.textContent = text;
  return n;
}

// 下拉里三种取值：全部 / 信息箱（folder_id 为 null）/ 具体文件夹的 uuid
const ALL = '__all__';
const INBOX = '';
const SELECTED_KEY = 'selectedFolder';

let selected = INBOX;

async function loadSelection() {
  const r = await chrome.storage.local.get(SELECTED_KEY);
  selected = r[SELECTED_KEY] ?? INBOX;
}
const saveSelection = () => chrome.storage.local.set({ [SELECTED_KEY]: selected });

function showBanner(html, kind = '') {
  bannerEl.innerHTML = html;
  bannerEl.className = kind;
  bannerEl.hidden = !html;
}

// ---- 渲染 ----

let state = { folders: [], posts: [] };
let firstLoad = true;      // 首次加载显示骨架屏，之后不再打断内容
let lastSignature = null;  // 数据没变就不重建 DOM

// 正文展开状态。只活在本次会话里 —— 这是临时的阅读动作，不值得持久化。
// 但必须记住，否则每次刷新重建卡片时展开的又缩回去了。
const expandedPosts = new Set();
const CLAMP_LINES = 6;

/** 当前选中的文件夹里有哪些帖子 */
function visiblePosts() {
  const { posts, folders } = state;
  if (selected === ALL) return posts;
  if (selected === INBOX) {
    const known = new Set(folders.map((f) => f.id));
    // 指向已删除文件夹的帖子当作未分类，否则会凭空消失
    return posts.filter((p) => isInbox(p.folderId) || !known.has(p.folderId));
  }
  return posts.filter((p) => p.folderId === selected);
}

/** 首屏骨架：给出"有内容正在来"的形状，而不是一片空白 */
function renderSkeleton() {
  const cards = [];
  for (let i = 0; i < 3; i++) {
    const card = el('div', 'post skeleton');
    card.append(el('div', 'sk-line'));
    for (const pct of [42, 88, 64]) {   // 长短错落，像真实的正文
      const line = el('div', 'sk-line');
      line.style.width = `${pct}%`;
      card.append(line);
    }
    cards.push(card);
  }
  listEl.replaceChildren(...cards);
}

/**
 * 顶部细进度条。
 * 只有请求超过 250ms 才显示 —— 本地后端通常几十毫秒就回来了，
 * 请求一快就闪一下的话，那是噪音不是反馈。
 */
let busyTimer = null;
function setBusy(busy) {
  clearTimeout(busyTimer);
  if (!busy) return void (progressEl.hidden = true);
  busyTimer = setTimeout(() => (progressEl.hidden = false), 250);
}

function renderPost(post, folders) {
  const card = el('div', 'post');

  const head = el('div', 'post-head');
  head.append(
    el('span', 'name', post.authorName ?? '未知作者'),
    el('span', 'handle', post.authorHandle ?? '')
  );
  card.append(head);

  if (post.text) {
    const text = el('p', 'text', post.text);
    const isOpen = expandedPosts.has(post.tweetId);
    if (!isOpen) text.classList.add('clamped');
    card.append(text);

    // 是否真的超长要等布局算完才知道，先建好按钮，渲染后统一测量
    const more = el('button', 'more', isOpen ? '收起' : '查看更多');
    more.hidden = true;
    more.addEventListener('click', () => {
      const nowOpen = !expandedPosts.has(post.tweetId);
      nowOpen ? expandedPosts.add(post.tweetId) : expandedPosts.delete(post.tweetId);
      // 直接改 DOM，不走 render —— 展开是纯界面动作，没必要重建整个列表
      text.classList.toggle('clamped', !nowOpen);
      more.textContent = nowOpen ? '收起' : '查看更多';
    });
    card.append(more);
  }

  if (post.mediaUrls?.length) {
    const media = el('div', 'media');
    for (const url of post.mediaUrls) {
      const img = new Image();
      img.src = url;
      img.loading = 'lazy';
      media.append(img);
    }
    card.append(media);
  }

  const footer = el('div', 'footer');
  if (post.permalink) {
    const a = el('a', null, '原帖');
    a.href = post.permalink;
    a.target = '_blank';
    a.rel = 'noreferrer';
    footer.append(a);
  }

  // 移动到其他文件夹
  const move = el('select', 'move');
  const inboxOpt = el('option', null, INBOX_NAME);
  inboxOpt.value = '';
  move.append(inboxOpt);
  for (const f of folders) {
    const opt = el('option', null, f.name);
    opt.value = f.id;
    move.append(opt);
  }
  move.value = isInbox(post.folderId) ? '' : post.folderId;
  move.addEventListener('change', async () => {
    try {
      await apiMovePost(post.tweetId, move.value || null);
    } catch (e) {
      showBanner(`移动失败：${e.message ?? e}`, 'error');
    }
    refresh();
  });
  footer.append(move);

  if (post.source) footer.append(el('span', 'badge', post.source === 'like' ? '❤️' : '🔖'));

  const del = el('button', 'del');
  del.innerHTML = TRASH_ICON;
  del.title = '从收藏库中移除';
  del.setAttribute('aria-label', '删除这条收藏');   // 图标按钮必须有可读名字
  del.addEventListener('click', async () => {
    const preview = (post.text ?? '').replace(/\n/g, ' ').slice(0, 24);
    if (!confirm(`从收藏库删除这条？\n\n${post.authorName ?? ''} ${preview}${preview.length >= 24 ? '…' : ''}`)) return;
    del.disabled = true;
    try {
      await apiDeletePost({ tweetId: post.tweetId });
      expandedPosts.delete(post.tweetId);
    } catch (e) {
      del.disabled = false;
      showBanner(`删除失败：${e.message ?? e}`, 'error');
    }
    refresh();
  });
  footer.append(del);

  card.append(footer);
  return card;
}

/**
 * 测量哪些正文真的超出了行数限制，只给这些显示「查看更多」。
 * 必须在元素进入布局之后跑。scrollHeight 给的是完整内容高度，
 * 不管当前是不是被 clamp 住，所以展开态下这个判断依然成立。
 */
function updateMoreButtons() {
  for (const text of listEl.querySelectorAll('.post .text')) {
    const more = text.nextElementSibling;
    if (!more?.classList.contains('more')) continue;
    const lineHeight = parseFloat(getComputedStyle(text).lineHeight) || 21;
    more.hidden = text.scrollHeight <= lineHeight * CLAMP_LINES + 2;
  }
}

/** 下拉里每项都带条数，不用再单独放一个计数 */
function renderFolderSelect() {
  const { folders, posts } = state;
  const known = new Set(folders.map((f) => f.id));
  const inboxCount = posts.filter((p) => isInbox(p.folderId) || !known.has(p.folderId)).length;

  const options = [
    { value: INBOX, label: `${INBOX_NAME} (${inboxCount})` },
    ...folders.map((f) => ({
      value: f.id,
      label: `${f.name} (${posts.filter((p) => p.folderId === f.id).length})`,
    })),
    { value: ALL, label: `全部 (${posts.length})` },
  ];

  folderSel.replaceChildren(
    ...options.map(({ value, label }) => {
      const o = el('option', null, label);
      o.value = value;
      return o;
    })
  );

  // 选中的文件夹被删掉了就回到信息箱
  if (!options.some((o) => o.value === selected)) {
    selected = INBOX;
    saveSelection();
  }
  folderSel.value = selected;

  // 重命名/删除只对用户建的文件夹有意义
  const isUserFolder = selected !== INBOX && selected !== ALL;
  renameBtn.hidden = !isUserFolder;
  delFolderBtn.hidden = !isUserFolder;
}

function emptyText() {
  if (selected === INBOX || selected === ALL) return '还没有收藏。去 X 点一下 ❤️ 试试。';
  return '这个文件夹还是空的';
}

function render() {
  const { folders, posts } = state;

  // 数据和选择都没变就别重建 DOM —— 否则滚动位置会被顶回去，
  // 正在操作的下拉也会被关掉。
  const signature = JSON.stringify([
    selected,
    folders.map((f) => [f.id, f.name]),
    posts.map((p) => [p.tweetId, p.folderId, p.text, p.authorName]),
  ]);
  if (signature === lastSignature) return;
  lastSignature = signature;

  renderFolderSelect();

  const visible = visiblePosts();
  listEl.replaceChildren(
    ...(visible.length ? visible.map((p) => renderPost(p, folders)) : [el('div', 'empty', emptyText())])
  );

  updateMoreButtons();
}

// ---- 数据 ----

async function refresh() {
  if (firstLoad) renderSkeleton();
  setBusy(true);
  try {
    await load();
  } finally {
    setBusy(false);
    firstLoad = false;
  }
}

async function load() {
  let posts = [];
  let folders = [];
  let error = null;
  try {
    [posts, folders] = await Promise.all([fetchPosts(), fetchFolders()]);
  } catch (e) {
    error = String(e.message ?? e);
  }

  state = { folders, posts };

  if (error) {
    showBanner(`连不上后端：${error}<br>确认后端已启动：<code>npm run server</code>`, 'error');
  } else if (bannerEl.className !== 'hint') showBanner('');

  render();
}

// ---- 交互 ----

folderSel.addEventListener('change', () => {
  selected = folderSel.value;
  saveSelection();
  render();
});

newFolderBtn.addEventListener('click', async () => {
  const name = prompt('文件夹名称');
  if (!name?.trim()) return;

  let folder;
  try {
    folder = await apiCreateFolder(name.trim());
  } catch (e) {
    return showBanner(`新建失败：${e.message ?? e}`, 'error');
  }
  selected = folder.id;   // 建完直接切过去，省一步点击
  saveSelection();
  refresh();
});

renameBtn.addEventListener('click', async () => {
  const current = state.folders.find((f) => f.id === selected);
  if (!current) return;
  const next = prompt('新的文件夹名', current.name);
  if (!next?.trim() || next === current.name) return;
  try {
    await apiRenameFolder(selected, next.trim());
  } catch (e) {
    showBanner(`重命名失败：${e.message ?? e}`, 'error');
  }
  refresh();
});

delFolderBtn.addEventListener('click', async () => {
  const current = state.folders.find((f) => f.id === selected);
  if (!current) return;
  const count = visiblePosts().length;
  if (!confirm(`删除文件夹「${current.name}」？里面的 ${count} 条会回到${INBOX_NAME}。`)) return;
  try {
    await apiDeleteFolder(selected);
    selected = INBOX;
    saveSelection();
  } catch (e) {
    showBanner(`删除失败：${e.message ?? e}`, 'error');
  }
  refresh();
});

/**
 * 不轮询。刷新只在三种时刻发生：
 *   1. 面板打开
 *   2. Service Worker 通知数据变了（在 X 上点赞或取消点赞）
 *   3. 面板重新变为可见（比如切回这个窗口）
 *
 * 之前是每 3 秒 setInterval —— 白跑查询是小事，更要命的是每次都会把
 * Service Worker 唤醒，让它永远休眠不了。
 */
let soonTimer = null;
function refreshSoon() {
  clearTimeout(soonTimer);
  soonTimer = setTimeout(refresh, 250);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'DATA_CHANGED') refreshSoon();
  return false; // 不占用消息通道
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshSoon();
});

await loadSelection();
await refresh();
