import { query, pool } from './db.mjs';

/**
 * 所有查询都带 user_id，且都带 deleted_at is null。
 * 这两条是租户隔离和软删除的底线，任何新增查询都必须遵守。
 */

const POST_COLUMNS = `
  tweet_id, permalink, author_handle, author_name, author_avatar,
  text_content, media_urls, posted_at, folder_id, note, source, saved_at
`;

// ---- 帖子 ----

export async function listPosts(userId) {
  const { rows } = await query(
    `select ${POST_COLUMNS} from saved_posts
     where user_id = $1 and deleted_at is null
     order by saved_at desc`,
    [userId]
  );
  return rows;
}

/**
 * 按 (user_id, tweet_id) upsert。
 * 冲突目标必须带上 where deleted_at is null —— 因为唯一索引是偏索引。
 * 重新收藏一条曾经删掉的帖子时，deleted_at 要清空。
 */
export async function upsertPost(userId, p) {
  const { rows } = await query(
    `insert into saved_posts (
       user_id, tweet_id, permalink, author_handle, author_name, author_avatar,
       text_content, media_urls, posted_at, folder_id, note, source, saved_at
     ) values ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,coalesce($13, now()))
     on conflict (user_id, tweet_id) where deleted_at is null
     do update set
       permalink     = excluded.permalink,
       author_handle = excluded.author_handle,
       author_name   = excluded.author_name,
       author_avatar = excluded.author_avatar,
       text_content  = excluded.text_content,
       media_urls    = excluded.media_urls,
       posted_at     = excluded.posted_at,
       source        = coalesce(excluded.source, saved_posts.source),
       -- folder_id 和 note 是用户的组织成果，重复收藏不能覆盖掉
       deleted_at    = null
     returning ${POST_COLUMNS}`,
    [
      userId,
      p.tweet_id,
      p.permalink,
      p.author_handle ?? null,
      p.author_name ?? null,
      p.author_avatar ?? null,
      p.text_content ?? null,
      JSON.stringify(p.media_urls ?? []),
      p.posted_at ?? null,
      p.folder_id ?? null,
      p.note ?? null,
      p.source ?? null,
      p.saved_at ?? null,
    ]
  );
  return rows[0];
}

export async function updatePost(userId, tweetId, patch) {
  const sets = [];
  const params = [userId, tweetId];
  for (const [col, val] of Object.entries(patch)) {
    params.push(val);
    sets.push(`${col} = $${params.length}`);
  }
  if (!sets.length) return null;

  const { rows } = await query(
    `update saved_posts set ${sets.join(', ')}
     where user_id = $1 and tweet_id = $2 and deleted_at is null
     returning ${POST_COLUMNS}`,
    params
  );
  return rows[0] ?? null;
}

/** 软删除。幂等：删不存在的也不报错，否则插件的重试队列会卡死 */
export async function softDeletePost(userId, tweetId) {
  const { rowCount } = await query(
    `update saved_posts set deleted_at = now()
     where user_id = $1 and tweet_id = $2 and deleted_at is null`,
    [userId, tweetId]
  );
  return rowCount;
}

// ---- 文件夹 ----

export async function listFolders(userId) {
  const { rows } = await query(
    `select id, name, parent_id, sort_order, created_at from folders
     where user_id = $1 and deleted_at is null
     order by sort_order, created_at`,
    [userId]
  );
  return rows;
}

/**
 * 新用户的初始文件夹。
 *
 * 信息箱不在其中 —— 它是 folder_id 为 null 的虚拟桶，对每个用户天然存在。
 * 建成实体行反而有害：能被删掉的话，未归类的帖子就无处可去了。
 *
 * 靠 (user_id, name) 唯一索引兜底，重复调用不会产生重复文件夹。
 */
export const DEFAULT_FOLDERS = ['文章', '想法', '观点', '建议'];

export async function seedDefaultFolders(userId) {
  const { rowCount } = await query(
    `insert into folders (user_id, name, sort_order)
     select $1, name, ord from unnest($2::text[]) with ordinality as t(name, ord)
     on conflict (user_id, name) where deleted_at is null do nothing`,
    [userId, DEFAULT_FOLDERS]
  );
  return rowCount;
}

export async function createFolder(userId, name) {
  const { rows } = await query(
    `insert into folders (user_id, name) values ($1, $2)
     returning id, name, parent_id, sort_order, created_at`,
    [userId, name]
  );
  return rows[0];
}

export async function renameFolder(userId, id, name) {
  const { rows } = await query(
    `update folders set name = $3
     where user_id = $1 and id = $2 and deleted_at is null
     returning id, name, parent_id, sort_order, created_at`,
    [userId, id, name]
  );
  return rows[0] ?? null;
}

/**
 * 删除文件夹：软删文件夹本身，里面的帖子回信息箱。
 *
 * 注意不能指望 folders 上的 on delete set null —— 那只在物理删除时触发，
 * 软删除必须自己把 folder_id 置空，否则帖子会指向一个"看不见"的文件夹。
 * 两步必须在同一个事务里。
 */
export async function deleteFolder(userId, id) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const { rowCount } = await client.query(
      `update folders set deleted_at = now()
       where user_id = $1 and id = $2 and deleted_at is null`,
      [userId, id]
    );
    const { rowCount: moved } = await client.query(
      `update saved_posts set folder_id = null
       where user_id = $1 and folder_id = $2 and deleted_at is null`,
      [userId, id]
    );
    await client.query('commit');
    return { deleted: rowCount, moved };
  } catch (e) {
    await client.query('rollback').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function folderExists(userId, id) {
  const { rowCount } = await query(
    `select 1 from folders where user_id = $1 and id = $2 and deleted_at is null`,
    [userId, id]
  );
  return rowCount > 0;
}
