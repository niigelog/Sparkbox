import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { shouldRemove } from '../src/shared/removal.js';
import { INBOX_ID } from '../src/shared/constants.js';

const untouched = { tweetId: '1', source: 'like', folderId: INBOX_ID, note: null, deleted: false };

describe('shouldRemove（取消点赞时该不该撤销）', () => {
  test('刚存进来没动过 → 撤销', () => {
    assert.equal(shouldRemove(untouched, 'like').remove, true);
  });

  test('已归类到其他目录 → 保留', () => {
    const r = shouldRemove({ ...untouched, folderId: 'reading' }, 'like');
    assert.equal(r.remove, false);
    assert.equal(r.reason, 'moved');
  });

  test('加过备注 → 保留', () => {
    const r = shouldRemove({ ...untouched, note: '这条有用' }, 'like');
    assert.equal(r.remove, false);
    assert.equal(r.reason, 'noted');
  });

  test('用书签存的却来取消点赞 → 保留', () => {
    const r = shouldRemove({ ...untouched, source: 'bookmark' }, 'like');
    assert.equal(r.remove, false);
    assert.equal(r.reason, 'source-mismatch');
  });

  test('取消收藏能撤销书签存的那条', () => {
    assert.equal(shouldRemove({ ...untouched, source: 'bookmark' }, 'bookmark').remove, true);
  });

  test('本地没有记录 → 不动', () => {
    assert.equal(shouldRemove(null, 'like').reason, 'not-found');
    assert.equal(shouldRemove(undefined, 'like').remove, false);
  });

  test('已经撤销过 → 不重复处理', () => {
    const r = shouldRemove({ ...untouched, deleted: true }, 'like');
    assert.equal(r.remove, false);
    assert.equal(r.reason, 'already-removed');
  });

  test('folderId 缺失当作在信息箱 → 撤销', () => {
    const { folderId, ...noFolder } = untouched;
    assert.equal(shouldRemove(noFolder, 'like').remove, true);
  });
});
