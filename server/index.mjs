#!/usr/bin/env node
/**
 * Sparkbox API 服务，数据落 Postgres。
 *
 *   npm run server
 */
import { createServer } from 'node:http';
import { pool, DEFAULT_USER_ID } from './db.mjs';
import * as repo from './repo.mjs';
import { currentUser } from './identity.mjs';

const PORT = Number(process.env.PORT ?? 7000);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const json = (res, status, data) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

async function readBody(req) {
  let s = '';
  for await (const c of req) {
    s += c;
    if (s.length > 1_000_000) throw new HttpError(413, '请求体过大');
  }
  if (!s) return {};
  try {
    return JSON.parse(s);
  } catch {
    throw new HttpError(400, 'JSON 格式错误');
  }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function route(req, res) {
  const { pathname } = new URL(req.url, 'http://localhost');
  const seg = pathname.split('/').filter(Boolean);
  const userId = await currentUser(req);

  if (pathname === '/health') {
    const { rows } = await pool.query('select 1 as ok');
    return json(res, 200, { ok: rows[0].ok === 1, user: userId });
  }

  if (seg[0] !== 'api') throw new HttpError(404, `no route for ${req.method} ${pathname}`);
  const [, resource, id] = seg;

  // ---- 文件夹 ----
  if (resource === 'folders') {
    if (req.method === 'GET' && !id) return json(res, 200, await repo.listFolders(userId));

    if (req.method === 'POST' && !id) {
      const { name } = await readBody(req);
      if (!name?.trim()) throw new HttpError(400, 'name 不能为空');
      try {
        return json(res, 201, await repo.createFolder(userId, name.trim()));
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, `已经有叫「${name.trim()}」的文件夹了`);
        throw e;
      }
    }

    if (req.method === 'PATCH' && id) {
      if (!UUID_RE.test(id)) throw new HttpError(400, 'id 不是合法 uuid');
      const { name } = await readBody(req);
      if (!name?.trim()) throw new HttpError(400, 'name 不能为空');
      try {
        const folder = await repo.renameFolder(userId, id, name.trim());
        if (!folder) throw new HttpError(404, '文件夹不存在');
        return json(res, 200, folder);
      } catch (e) {
        if (e.code === '23505') throw new HttpError(409, `已经有叫「${name.trim()}」的文件夹了`);
        throw e;
      }
    }

    if (req.method === 'DELETE' && id) {
      if (!UUID_RE.test(id)) throw new HttpError(400, 'id 不是合法 uuid');
      // 幂等：删不存在的也返回 200
      return json(res, 200, { ok: true, ...(await repo.deleteFolder(userId, id)) });
    }
  }

  // ---- 帖子 ----
  if (resource === 'posts') {
    if (req.method === 'GET' && !id) return json(res, 200, await repo.listPosts(userId));

    if (req.method === 'POST' && !id) {
      const post = await readBody(req);
      if (!post.tweet_id?.trim()) throw new HttpError(400, 'tweet_id 必填');
      if (!post.permalink) throw new HttpError(400, 'permalink 必填');
      if (post.folder_id && !(await repo.folderExists(userId, post.folder_id))) {
        throw new HttpError(400, 'folder_id 指向的文件夹不存在');
      }
      return json(res, 200, await repo.upsertPost(userId, post));
    }

    if (req.method === 'PATCH' && id) {
      const body = await readBody(req);
      const patch = {};
      if ('folder_id' in body) {
        const fid = body.folder_id || null; // 空字符串按信息箱处理
        if (fid !== null) {
          if (!UUID_RE.test(fid)) throw new HttpError(400, 'folder_id 不是合法 uuid');
          if (!(await repo.folderExists(userId, fid))) {
            throw new HttpError(400, 'folder_id 指向的文件夹不存在');
          }
        }
        patch.folder_id = fid;
      }
      if ('note' in body) patch.note = body.note;
      if (!Object.keys(patch).length) throw new HttpError(400, '没有可更新的字段');

      const post = await repo.updatePost(userId, id, patch);
      if (!post) throw new HttpError(404, '帖子不存在');
      return json(res, 200, post);
    }

    if (req.method === 'DELETE' && id) {
      // 幂等：删不存在的也返回 200，否则插件的重试队列会无限重试
      const deleted = await repo.softDeletePost(userId, id);
      return json(res, 200, { ok: true, deleted });
    }
  }

  throw new HttpError(404, `no route for ${req.method} ${pathname}`);
}

const server = createServer(async (req, res) => {
  // 插件的请求来自扩展的 Service Worker，属于跨域
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader(
    'access-control-allow-headers',
    'content-type, x-sparkbox-user-id, x-sparkbox-handle, x-sparkbox-name'
  );
  res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const t0 = Date.now();
  try {
    await route(req, res);
  } catch (e) {
    if (e instanceof HttpError) json(res, e.status, { error: e.message });
    else {
      console.error(`[500] ${req.method} ${req.url}`, e);
      json(res, 500, { error: '服务内部错误' });
    }
  }
  const ms = Date.now() - t0;
  if (req.method !== 'GET' || process.env.LOG_GET) {
    console.log(`${req.method} ${req.url} ${res.statusCode} ${ms}ms`);
  }
});

server.listen(PORT, '192.168.101.12', async () => {
  console.log(`Sparkbox API → http://192.168.101.12:${PORT}`);
  try {
    const { rows } = await pool.query(
      `select
         (select count(*) from saved_posts where user_id = $1 and deleted_at is null) posts,
         (select count(*) from folders     where user_id = $1 and deleted_at is null) folders`,
      [DEFAULT_USER_ID]
    );
    console.log(`数据库 ${process.env.APP_POSTGRES_DB}@${process.env.APP_POSTGRES_HOST}`);
    console.log(`当前用户 ${DEFAULT_USER_ID}：${rows[0].posts} 条帖子、${rows[0].folders} 个文件夹`);
  } catch (e) {
    console.error(`\n连不上数据库：${e.message}`);
    console.error('先跑 npm run db:migrate 确认表结构存在\n');
  }
});

// 优雅退出：别把连接池里的连接留在数据库上
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('\n正在关闭…');
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
