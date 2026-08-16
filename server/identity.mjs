import { query } from './db.mjs';
import { seedDefaultFolders } from './repo.mjs';
import { DEFAULT_USER_ID } from './db.mjs';

/**
 * 从请求头解析出「这是谁」。
 *
 * 插件读 X 的 twid cookie，把数字 ID 放在 x-sparkbox-user-id 里发过来。
 *
 * **注意这只是识别，不是认证。** 服务端无法验证这个 ID 的真假，
 * 任何能访问本接口的进程都能冒充任意用户。绑 127.0.0.1 时威胁模型基本为零；
 * **一旦绑到 0.0.0.0（比如跑在 Docker 里），同局域网的任何人都能读写全部收藏**，
 * 那时必须换成 X OAuth，由服务端去 X 那边验一次。
 */

const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;

function decodeName(raw) {
  if (!raw) return null;
  try {
    return decodeURIComponent(raw).slice(0, 100);
  } catch {
    return null;
  }
}

/**
 * 按 x_user_id 找用户，没有就建。
 *
 * 首次见到某个 X 账号时，如果那个播种出来的默认账户还没被认领，就让它认领 ——
 * 这样从「写死单用户」切过来时，之前存的收藏不会变成孤儿。
 */
async function resolveByXUserId(xUserId, { handle, name }) {
  const found = await query(
    `select id from users where x_user_id = $1 and deleted_at is null`,
    [xUserId]
  );
  if (found.rowCount) {
    // 顺手更新可读信息，改了 handle 也能跟上
    if (handle || name) {
      await query(
        `update users set x_handle = coalesce($2, x_handle), display_name = coalesce($3, display_name)
         where id = $1`,
        [found.rows[0].id, handle, name]
      );
    }
    return found.rows[0].id;
  }

  const claimed = await query(
    `update users set x_user_id = $2, x_handle = coalesce($3, x_handle),
                      display_name = coalesce($4, display_name)
     where id = $1 and x_user_id is null and deleted_at is null
     returning id`,
    [DEFAULT_USER_ID, xUserId, handle, name]
  );
  if (claimed.rowCount) {
    // 默认账户是迁移播出来的，可能还没有初始文件夹
    await seedDefaultFolders(claimed.rows[0].id);
    return claimed.rows[0].id;
  }

  const created = await query(
    `insert into users (x_user_id, x_handle, display_name) values ($1, $2, $3) returning id`,
    [xUserId, handle, name]
  );
  await seedDefaultFolders(created.rows[0].id);
  return created.rows[0].id;
}

/** 解析当前请求属于哪个用户；没带身份头时退回默认账户 */
export async function currentUser(req) {
  const xUserId = req.headers['x-sparkbox-user-id'];
  if (!xUserId || !/^\d{1,25}$/.test(xUserId)) return DEFAULT_USER_ID;

  const rawHandle = req.headers['x-sparkbox-handle'];
  const handle = HANDLE_RE.test(rawHandle ?? '') ? rawHandle : null;
  return resolveByXUserId(xUserId, { handle, name: decodeName(req.headers['x-sparkbox-name']) });
}
