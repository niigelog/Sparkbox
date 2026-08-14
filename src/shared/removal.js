import { isInbox } from './constants.js';

/**
 * 取消点赞/取消收藏时，判断该不该把这条撤掉。
 * 原则：只撤销「刚存进来还没动过」的，已经归类或标注过的一律保留 —— 那是用户的劳动成果。
 *
 * @param record 云端返回的记录（或本地发件箱里还没推上去的），没有则传 null
 * @param source 取消动作对应的来源：unlike → 'like'，removeBookmark → 'bookmark'
 */
export function shouldRemove(record, source) {
  if (!record) return { remove: false, reason: 'not-found' };
  if (record.deleted) return { remove: false, reason: 'already-removed' };
  // 用书签存的、却来取消点赞，不算撤销同一个动作
  if (record.source !== source) return { remove: false, reason: 'source-mismatch' };
  if (!isInbox(record.folderId)) return { remove: false, reason: 'moved' };
  if (record.note) return { remove: false, reason: 'noted' };
  return { remove: true, reason: 'untouched' };
}

export const KEEP_REASONS = {
  'not-found': '本地没有这条记录',
  'already-removed': '已经移除过了',
  'source-mismatch': '这条是用另一个按钮存的，保留',
  moved: '已归类到其他文件夹，保留',
  noted: '已加过备注，保留',
};
