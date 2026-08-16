import { identityHeaders } from '../../shared/identity.js';

const ENDPOINT = __SYNC_ENDPOINT__; // 形如 http://192.168.101.12:7000/api/posts
const BASE = ENDPOINT.replace(/\/posts\/?$/, ''); // → http://192.168.101.12:7000/api

// 内容脚本从页面上读到的 handle / 显示名，只是给人看的附加信息
let actorHint = {};
export function setActor(actor) {
  if (actor?.handle) actorHint = actor;
}

/** 字段名对齐 supabase/schema.sql，方便本地服务和云端用同一套表结构 */
function toPayload(post) {
  return {
    tweet_id: post.tweetId,
    permalink: post.permalink,
    author_handle: post.authorHandle,
    author_name: post.authorName,
    text_content: post.text,
    media_urls: post.mediaUrls ?? [],
    posted_at: post.postedAt,
    folder_id: post.folderId ?? null, // null = 信息箱
    source: post.source ?? null, // like | bookmark
    saved_at: post.savedAt,
  };
}

/** 云端行 → 界面用的形状 */
export function fromRow(row) {
  return {
    tweetId: row.tweet_id,
    permalink: row.permalink,
    authorHandle: row.author_handle,
    authorName: row.author_name,
    text: row.text_content,
    mediaUrls: row.media_urls ?? [],
    postedAt: row.posted_at,
    folderId: row.folder_id ?? null,
    source: row.source,
    note: row.note,
    savedAt: row.saved_at,
  };
}

/** 每个请求都带上身份头，服务端据此定位用户 */
async function request(url, init = {}) {
  let res;
  try {
    res = await fetch(url, {
      ...init,
      headers: { ...(init.headers ?? {}), ...(await identityHeaders(actorHint)) },
    });
  } catch (e) {
    // 服务没起来 / 端口不通 —— queue.js 认 Failed to fetch 这个前缀会中断本轮
    throw new Error(`Failed to fetch ${url}: ${e.message}`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`.trim());
  }
  return res.status === 204 ? null : res.json().catch(() => null);
}

const json = (method, body) => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// ---- 帖子 ----

export async function pushPost(post) {
  await request(ENDPOINT, json('POST', toPayload(post)));
}

/** 撤销保存：DELETE {ENDPOINT}/{tweet_id}。后端删不存在的也应返回 2xx（幂等） */
export async function deletePost(post) {
  await request(`${ENDPOINT}/${encodeURIComponent(post.tweetId)}`, { method: 'DELETE' });
}

export async function fetchPosts() {
  const rows = (await request(ENDPOINT)) ?? [];
  return rows.map(fromRow);
}

export async function movePost(tweetId, folderId) {
  await request(`${ENDPOINT}/${encodeURIComponent(tweetId)}`, json('PATCH', { folder_id: folderId }));
}

// ---- 文件夹 ----

export async function fetchFolders() {
  return (await request(`${BASE}/folders`)) ?? [];
}

export async function createFolder(name) {
  return await request(`${BASE}/folders`, json('POST', { name }));
}

export async function renameFolder(id, name) {
  return await request(`${BASE}/folders/${encodeURIComponent(id)}`, json('PATCH', { name }));
}

/** 删除文件夹：其中的帖子回到信息箱，由后端负责 */
export async function deleteFolder(id) {
  await request(`${BASE}/folders/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
