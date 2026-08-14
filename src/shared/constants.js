/**
 * 信息箱 = 未分类。云端用 folder_id = null 表示，
 * 这样才对得上 saved_posts.folder_id 的 uuid 外键（不能塞字符串 'inbox'）。
 */
export const INBOX_ID = null;
export const INBOX_NAME = '信息箱';

export const isInbox = (folderId) => folderId == null;
