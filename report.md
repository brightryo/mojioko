# OFL License Compliance — Fix Report

**Branch**: `feature/font-selection`
**Commits**: `4522176`, `d6fe440` (this work)
**Pushed / merged**: ❌ no — local-only as instructed

---

## 1. 何が違反状態だったか

OFL §3.2 ("Each copy of the Font Software must contain the above copyright
notice and this license") に対し、`v1.1.0` 〜 `v1.1.1` の MOJIOKO は:

- インストーラに `NotoSansJP-{Regular,Medium,SemiBold}.ttf` を同梱しているが、
  そのライセンス文 (SIL OFL v1.1) を一切同梱していなかった。
- `installer/licenses/` には electron/react/faster-whisper/ffmpeg の MIT/LGPL
  はあったが、Noto の OFL が欠落。
- アプリ内 FontLicensesDialog で Noto を選んでも 1 行 copyright 文字列しか
  表示されなかった (full SIL OFL v1.1 がアプリ内のどこからも見られない)。

→ Public 化済み & 配布開始済みの状況で **OFL 違反**。

## 2. 実施した対応

### A. Noto Sans JP の OFL.txt を upstream から取得

ソース: `https://github.com/notofonts/noto-cjk/raw/main/Sans/LICENSE`
(canonical SIL OFL v1.1、4301 bytes、PREAMBLE + 5 conditions + DEFINITIONS
の全文)。

### B. `resources/fonts/Noto_Sans_JP/OFL.txt` に配置

3 つの weight variant TTF と同じ family root ディレクトリに 1 つ置く形 (各
weight ごとに重複させない)。

### C. `installer/licenses/noto-sans-jp-ofl.txt` に複製

`installer/licenses/` 配下の他コンポーネント (`electron-mit.txt` 等) と並べる
ことで、配布物の license dir からも参照可能に。`installer/licenses/README.md`
にも Noto Sans JP と downloaded fonts の節を追加。

### D. `electron-builder.yml` の filter を拡張

```diff
   - from: resources/fonts
     to: fonts
     filter:
       - "**/*.ttf"
+      - "**/OFL.txt"
+      - "**/LICENSE*"
```

これで packaged build に `OFL.txt` が含まれる。

### E. `src/main/ipc/font.ts:fontReadOfl` の bundled ガード解除

```diff
-    const userPath = join(getFontUserDir(fontId), 'OFL.txt')
-    if (!meta.bundled && existsSync(userPath)) {
-      const buf = await fs.readFile(userPath, 'utf-8')
-      return { ok: true, data: buf }
-    }
-    return { ok: true, data: meta.copyright }
+    const oflPath = meta.bundled
+      ? getBundledOflPath(meta)
+      : join(getFontUserDir(fontId), 'OFL.txt')
+    if (oflPath && existsSync(oflPath)) {
+      const buf = await fs.readFile(oflPath, 'utf-8')
+      return { ok: true, data: `${meta.copyright}\n\n${buf}` }
+    }
+    log.warn(`[ipc/font] OFL.txt missing for ${fontId}; falling back to registry copyright`)
+    return { ok: true, data: meta.copyright }
```

Bundled / downloaded 両方とも `OFL.txt` を実体から読み、registry の
`copyright` フィールド (=「Copyright 2014-2021 Adobe..., licensed under
the SIL Open Font License, Version 1.1.」) を全文の先頭に prepend。

### F. `src/main/lib/paths.ts:getBundledOflPath(meta)` を追加

```ts
export function getBundledOflPath(meta: FontMeta): string | null {
  if (!meta.bundled) return null
  const rel = meta.bundledRelativeDir ?? ''
  const familyRoot = rel.includes('/') ? rel.split('/')[0] : rel
  return join(getFontsBundledRoot(), familyRoot, 'OFL.txt')
}
```

`Noto_Sans_JP/static` のような `static/` サブパスを持つレイアウトでは、
family root に 1 つだけ OFL.txt が居る前提を取り、weight ごとの重複は不要。

## 3. THIRD_PARTY_LICENSES 問題 (EULA §1.2 整合性)

EULA は "the license terms set forth separately in THIRD_PARTY_LICENSES
shall apply" と書いてあるが、そのファイル/サーフェスが現状アプリ内に存在
していなかった。最小対応として:

- `installer/licenses/README.md` を **third-party manifest** として整備
  (Noto Sans JP + downloaded fonts 節を追記)。
- 新 IPC `shell:openThirdPartyLicensesFolder`:
  - packaged: `<resourcesPath>/licenses/` を OS の file explorer で開く
  - dev: `<appPath>/installer/licenses/` を開く (同じ中身)
- About ダイアログに **「Open third-party licenses folder →」**リンクを追加。
  Font licenses リンクと並ぶ位置。

これで EULA の文言が指し示す surface が実際に到達可能になった。

## 4. Inter のクリーンアップ

`resources/fonts/Inter/Inter-Variable.woff2` (OFL) は:
- `fonts.css` で `@font-face` がコメントアウト → 実際にロードされない
- `electron-builder.yml` の filter が `**/*.ttf` で **woff2 は packaged に含まれない**
- → アプリ実体としては未使用

しかし Public リポジトリ化済みなので **GitHub clone 経由の配布**になっていた。
未使用フォントの OFL 整備をするより、削除して問題を消す方を採用 (ユーザー判断
通り):

- `resources/fonts/Inter/Inter-Variable.woff2` 削除
- `resources/fonts/Inter/.gitkeep` 削除
- `src/renderer/styles/fonts.css` の Inter @font-face コメントブロック削除
- `src/renderer/lib/tokens.ts:fontSans` から `'Inter'` を除去 (システム Inter が
  あった場合に意図しないフォントで UI が描画されるのを防ぐ)

## 5. 検証結果

| 項目 | 結果 |
|---|---|
| `npm run typecheck` | ✅ pass |
| `npm run lint` | ✅ pass |
| `npm run build` | ✅ pass (main 74KB / preload 5.8KB / renderer JS 1.95MB) |
| OFL.txt static verify (Node) | ✅ SIL OPEN FONT LICENSE / PREAMBLE / PERMISSION すべて検出、4301 bytes |
| `npm run dev` startup | ✅ MOJIOKO 1.1.1 起動、エラー無し |
| FontLicensesDialog で Noto OFL 全文表示 (GUI) | 🟡 自動検証不可。IPC 経路は確認済み (上記の static verify で contents が正しい) |

GUI スモークの自動検証は環境制約で不可能。**オーナー側で手動確認推奨**:
1. `npm run dev` 起動
2. About ダイアログを開く
3. 「Font licenses →」をクリック → FontLicensesDialog 表示
4. Noto Sans JP の行で「+ OFL.txt を表示」をクリック → registry copyright +
   SIL OFL v1.1 全文 (PREAMBLE / 5 conditions / TERMINATION 等) が表示される
   ことを目視確認
5. About ダイアログに戻り「Open third-party licenses folder →」をクリック →
   `installer/licenses/` フォルダが explorer で開き、5 つの license ファイルが
   並んでいることを確認

## 6. 変更ファイル一覧

| ファイル | 種別 |
|---|---|
| `resources/fonts/Noto_Sans_JP/OFL.txt` | 追加 (4301 bytes) |
| `installer/licenses/noto-sans-jp-ofl.txt` | 追加 (同上のコピー) |
| `installer/licenses/README.md` | 編集 (Noto + DL font 節追加) |
| `electron-builder.yml` | 編集 (filter 拡張) |
| `src/main/lib/paths.ts` | 編集 (`getBundledOflPath` 追加) |
| `src/main/ipc/font.ts` | 編集 (`fontReadOfl` bundled 経路) |
| `src/main/ipc/shell.ts` | 編集 (`shellOpenThirdPartyLicensesFolder` 追加) |
| `src/shared/ipc-channels.ts` | 編集 (新 channel) |
| `src/preload/index.ts` | 編集 (新 channel binding) |
| `src/renderer/env.d.ts` | 編集 (型) |
| `src/renderer/components/about-dialog/about-dialog.tsx` | 編集 (新リンク追加) |
| `src/renderer/locales/en/common.json` | 編集 (`thirdPartyLicenses.*`) |
| `src/renderer/locales/ja/common.json` | 編集 (同上 JA) |
| `resources/fonts/Inter/Inter-Variable.woff2` | **削除** |
| `resources/fonts/Inter/.gitkeep` | **削除** |
| `src/renderer/styles/fonts.css` | 編集 (Inter コメント節削除) |
| `src/renderer/lib/tokens.ts` | 編集 (`fontSans` から Inter 除去) |

合計: 17 files changed (commit `d6fe440` で 15、`4522176` で 2)。

## 7. 未着手 / オーナーに残るタスク

| 項目 | 内容 |
|---|---|
| GUI スモーク | 上記 §5 の手順で目視確認 |
| push | `git push -u origin feature/font-selection` (本ブランチ未 push) |
| マージ判断 | OFL 違反は配布済み状態。可能なら早期 main へマージ + v1.1.1 リビルド (`npm run build:win`) + GitHub Releases 差し替え。マージ完了後、`releases/v1.1.0` も同じ違反状態のまま残る点に注意 (アセット差し替え or リリースノートで補足) |
| 残り 7 OFL フォント | DL 経路は元から OFL.txt も DL して `%APPDATA%/MOJIOKO/fonts/<id>/` に置く実装 → アップロード時に各フォントに対応する OFL を `fonts-v1` Release に同名で含めれば自動的に整合する |
| 過去配布物 (v1.0.0/v1.0.1/v1.1.0/v1.1.1) の扱い | 厳密にいえば全部 OFL 違反状態で配布された。実害は低いが、新しいリビルドで上書きするのが望ましい |

## 8. コミット履歴

```
4522176 chore: drop Inter from fonts.css and tokens.ts after removal
d6fe440 fix(licenses): ship Noto OFL alongside the font + surface in-app
7b84081 fix(ui): shorter Step 1 preview frame + dark-themed scrollbars
62554cc fix(fonts): preview font in Step 2 + license dialog wiring
d1a8803 docs(font-validation): scripts + ASS fixtures for the pipeline smoke
44a4830 chore: bump version to 1.1.1
... (これより前は font-selection feature 本体 11 commits)
```
