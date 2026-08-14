import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = __SUPABASE_URL__;
const SUPABASE_ANON_KEY = __SUPABASE_ANON_KEY__;
const DEFAULT_ACCOUNT = { email: __DEFAULT_EMAIL__, password: __DEFAULT_PASSWORD__ };

// 坑 1：supabase-js 默认把 session 存 localStorage，而 MV3 Service Worker 里
// 根本没有 localStorage —— 不换掉这个 adapter，每次 SW 被回收都要重新登录。
const chromeStorage = {
  async getItem(key) {
    const r = await chrome.storage.local.get(key);
    return r[key] ?? null;
  },
  async setItem(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async removeItem(key) {
    await chrome.storage.local.remove(key);
  },
};

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storage: chromeStorage,
    persistSession: true,
    detectSessionInUrl: false,
    // 坑 2：autoRefreshToken 内部靠 setInterval 定时续期，SW 一休眠计时器就没了，
    // 醒来后拿着过期 token 静默失败。关掉它，改成每次用之前手动检查（见下）。
    autoRefreshToken: false,
  },
});

const EXPIRY_MARGIN_SEC = 60;

function isExpiring(session) {
  if (!session?.expires_at) return true;
  return session.expires_at - EXPIRY_MARGIN_SEC <= Math.floor(Date.now() / 1000);
}

/**
 * 保证拿到一个可用 session：优先复用 → 快过期就刷新 → 刷新失败再用默认账户登录。
 * 所有需要访问云端的地方都必须先走这里。
 */
export async function ensureSession() {
  const { data } = await supabase.auth.getSession();
  let session = data.session;

  if (session && !isExpiring(session)) return session;

  if (session?.refresh_token) {
    const { data: refreshed } = await supabase.auth.refreshSession({
      refresh_token: session.refresh_token,
    });
    if (refreshed?.session) return refreshed.session;
  }

  const { data: signedIn, error } = await supabase.auth.signInWithPassword(DEFAULT_ACCOUNT);
  if (error) throw new Error(`自动登录失败: ${error.message}`);
  return signedIn.session;
}

/** 把本地记录映射成 saved_posts 的行结构 */
export function toRow(post, userId) {
  return {
    user_id: userId,
    tweet_id: post.tweetId,
    permalink: post.permalink,
    author_handle: post.authorHandle,
    author_name: post.authorName,
    text_content: post.text,
    media_urls: post.mediaUrls,
    posted_at: post.postedAt,
    folder_id: post.folderId ?? null, // null = 信息箱
    source: post.source ?? null,
    saved_at: post.savedAt,
  };
}

export async function pushPost(post) {
  const session = await ensureSession();
  const { error } = await supabase
    .from('saved_posts')
    .upsert(toRow(post, session.user.id), { onConflict: 'user_id,tweet_id' });
  if (error) throw new Error(error.message);
}

export async function deletePost(post) {
  const session = await ensureSession();
  const { error } = await supabase
    .from('saved_posts')
    .delete()
    .eq('user_id', session.user.id)
    .eq('tweet_id', post.tweetId);
  if (error) throw new Error(error.message);
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

export async function fetchPosts() {
  const session = await ensureSession();
  const { data, error } = await supabase
    .from('saved_posts')
    .select('*')
    .eq('user_id', session.user.id)
    .order('saved_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(fromRow);
}

export async function movePost(tweetId, folderId) {
  const session = await ensureSession();
  const { error } = await supabase
    .from('saved_posts')
    .update({ folder_id: folderId })
    .eq('user_id', session.user.id)
    .eq('tweet_id', tweetId);
  if (error) throw new Error(error.message);
}

// ---- 文件夹 ----

export async function fetchFolders() {
  const session = await ensureSession();
  const { data, error } = await supabase
    .from('folders')
    .select('id, name, created_at')
    .eq('user_id', session.user.id)
    .order('created_at');
  if (error) throw new Error(error.message);
  return data ?? [];
}

export async function createFolder(name) {
  const session = await ensureSession();
  const { data, error } = await supabase
    .from('folders')
    .insert({ user_id: session.user.id, name })
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function renameFolder(id, name) {
  const session = await ensureSession();
  const { data, error } = await supabase
    .from('folders')
    .update({ name })
    .eq('user_id', session.user.id)
    .eq('id', id)
    .select()
    .single();
  if (error) throw new Error(error.message);
  return data;
}

export async function deleteFolder(id) {
  const session = await ensureSession();
  // 先把里面的帖子放回信息箱，再删文件夹
  const { error: e1 } = await supabase
    .from('saved_posts')
    .update({ folder_id: null })
    .eq('user_id', session.user.id)
    .eq('folder_id', id);
  if (e1) throw new Error(e1.message);
  const { error } = await supabase
    .from('folders')
    .delete()
    .eq('user_id', session.user.id)
    .eq('id', id);
  if (error) throw new Error(error.message);
}
