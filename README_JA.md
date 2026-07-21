# MOJIOKO

文字起こし字幕動画作成ツール。動画の音声を自動文字起こしし、字幕付き動画を生成できます。
すべての処理は PC 内で完結し、データが外部に送信されることはありません。
GitHub で配布する無料版と Microsoft Store で販売する有料版があり、
基本機能（自動文字起こし・字幕編集・字幕焼き込み・SRT／テキスト書き出し）はどちらも同じです。

[ダウンロード](https://brightryo.github.io/mojioko/) | [English README](README.md)

---

## 主な機能

- **ローカル処理** — 文字起こしから書き出しまで、すべて PC 内で完結。クラウド連携・データ送信なし。
- **多形式対応** — 動画は MKV / MP4、音声は MP3 / WAV / M4A / AAC / FLAC / OGG を読み込み可能。
- **音声ファイル入力** — 音声ファイルを直接文字起こしし、テキスト / SRT 形式で出力(焼き込みステップなし)。
- **フォントカスタマイズ** — 13 種のフォント (Noto Sans JP + Google Fonts 12 種：和文 8 種＋欧文 4 種) を搭載、行ごとに別フォント指定可能。追加 12 種は有料版のみで利用可能、無料版は Noto Sans JP のみ。
- **縦型動画対応** — TikTok、YouTube Shorts、Instagram Reels 用の字幕制作にも利用可。
- **MP4 書き出し** — SNS 投稿に最適化された MP4 出力（`+faststart` 付き）。
- **多言語文字起こし** — OpenAI Whisper による 11 言語対応。
- **GPU エンコード** — NVIDIA / AMD / Intel GPU を自動検出。GPU 非搭載でも動作。
- **字幕エディタ** — インライン編集、時間調整、Undo/Redo、テキスト・SRT 形式での書き出し。
- **タイムライントリミング** — タイムライン上で始点・終点を打ち、動画の尺ごと不要な区間を字幕ごと削除。トリミング位置に残る「はさみマーカー」をクリックすれば取り消し可能（入れ子のトリミングは外側から段階的に解除）。
- **カラーパレット** — 基本色 / おすすめペア / 色弱向け (CUD) の 30 色を全箇所で統一。
- **DaVinci Resolve 互換** — SRT 出力は DaVinci Resolve 等の動画編集ソフトでそのまま使用可能。

## 動作環境

- **OS**: Windows 10 / 11 (64-bit)
- **メモリ**: 8 GB 以上推奨（16 GB あると快適）
- **ディスク容量**: アプリ本体約 2 GB + Whisper large-v3 モデル約 3 GB（任意）
- **GPU**: 不要（あれば自動でハードウェアエンコード利用）

## クイックスタート

1. [公式ダウンロードページ](https://brightryo.github.io/mojioko/) からインストーラを取得
2. インストーラを実行（管理者権限不要）
3. MOJIOKO を起動
4. Whisper モデルを選択してダウンロード（初回のみ）
5. 動画ファイルを選択 → 文字起こし → 編集 → 書き出し

## ドキュメント

- **[ダウンロードページ](https://brightryo.github.io/mojioko/)** — 最新版と概要
- **[CHANGELOG.md](CHANGELOG.md)** — 変更履歴
- **[PRIVACY.md](PRIVACY.md)** — プライバシーポリシー
- **[LICENSE](build/license_ja.txt)** — 利用規約

## 開発を応援

MOJIOKO の無料版（GitHub）は無償でご利用いただけます。有料版（Microsoft Store）は、
MOJIOKO が用意した追加の字幕フォントが利用できるほか、購入自体が開発の支援にもなります。
無料版がお役に立てましたら、以下のいずれかの形でのご支援もご検討ください。

- **[Buy Me a Coffee](https://buymeacoffee.com/brightryog)** — グローバル・アカウント不要・$3〜
- **[BOOTH](https://brightryo.booth.pm/items/8414334)** — PayPay・コンビニ・クレジットカード対応・¥300〜
- **[GitHub Sponsors](https://github.com/sponsors/brightryo)** — 月額・単発どちらも可能・GitHub アカウント必要

## 不具合報告・要望

バグ報告や機能要望は [GitHub Issues](https://github.com/brightryo/mojioko/issues) からお願いします。

## ソースコードの公開について

MOJIOKO のソースコードは、アプリの挙動を誰でも確認できるよう、
プライバシー方針を検証できるよう、また開発の履歴を追えるよう、この
GitHub リポジトリで公開しています。

**この公開はオープンソースライセンスの付与ではありません。**
MOJIOKO は独自ライセンス（プロプライエタリ）のソフトウェアであり、
ソースは*参照目的で公開されているだけ*で、二次利用のためのライセンスは
付与されていません。特に以下の行為は許可されていません。

- リポジトリをクローンして実行ファイルをビルドし、BrightRyo が
  配布する無料版・有料版の代わりに使用すること。
- 無料版と有料版の機能制限を回避するようコードを改変し、そのビルド版を
  いかなる目的でも使用すること。
- 改変版または未改変のソースコード、およびそれらからビルドした
  実行ファイルを第三者に再配布すること。

正式な条件文はリポジトリルートの [LICENSE](LICENSE)（英語）に、
対応する EULA 条項は [使用許諾契約書](build/license_ja.txt) の §3.3 /
§3.4 / §3.5 / §3.9 / §3.10 にあります。

MOJIOKO の使用を希望される場合は、[ダウンロードページ]
(https://brightryo.github.io/mojioko/) から無料版を取得するか、
[Microsoft Store](https://apps.microsoft.com/detail/9N03JMH9LF6M)
で有料版をご購入ください。

## ライセンス

プロプライエタリ。リポジトリレベルの宣言は [LICENSE](LICENSE)
（英語）を、正式な使用許諾契約書（日本語）は
[build/license_ja.txt](build/license_ja.txt) をご確認ください。

Copyright © 2026 BrightRyo. All rights reserved.

本ソフトウェアの一部は copyright © 2006-2026 The FreeType Project
(https://freetype.org) の権利を含みます。All rights reserved.

---

## 補足事項

- **SmartScreen 警告について**: インストーラはコード署名されていないため、初回起動時に Windows Defender SmartScreen の警告が表示される場合があります。コード署名は今後のバージョンで対応予定です。
- **自動更新**: 自動更新機能は実装していません。ヘルプ → ダウンロードページを開く から手動で確認できます。
- **macOS / Linux**: 現在は Windows のみ対応です。
