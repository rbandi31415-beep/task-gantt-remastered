// テスト用の最小 obsidian スタブ / minimal obsidian stub for tests
// クラスは globalThis で共有：バンドルごとにスタブが複製されても instanceof が通るように
// classes are shared through globalThis so instanceof works even when each bundle inlines its own copy
export class App {}
export const TFile = (globalThis.__stubTFile ??= class TFile {});
export const TFolder = (globalThis.__stubTFolder ??= class TFolder {});
export function normalizePath(p) {
  return p;
}
// タグ取得スタブ / tag stub
export function getAllTags() {
  return null;
}
