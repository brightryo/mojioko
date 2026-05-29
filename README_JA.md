# MOJIOKO

無料の文字起こし動画作成ツール。動画の音声を自動文字起こしし、字幕付き動画を生成できます。
すべての処理は PC 内で完結し、データが外部に送信されることはありません。

[ダウンロード](https://brightryo.github.io/mojioko/) | [English README](README.md)

---

## 主な機能

- **ローカル処理** — 文字起こしから書き出しまで、すべて PC 内で完結。クラウド連携・データ送信なし。
- **多形式対応** — MKV、MP4、MOV（iPhone 撮影動画）、AVI を読み込み可能。
- **縦型動画対応** — TikTok、YouTube Shorts、Instagram Reels 用の字幕制作にも利用可。
- **MP4 書き出し** — SNS 投稿に最適化された MP4 出力（`+faststart` 付き）。
- **多言語文字起こし** — OpenAI Whisper による 11 言語対応。
- **GPU エンコード** — NVIDIA / AMD / Intel GPU を自動検出。GPU 非搭載でも動作。
- **字幕エディタ** — インライン編集、時間調整、Undo/Redo、テキスト・SRT 形式での書き出し。
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

MOJIOKO は無料でご利用いただけます。お役に立てましたら、開発の支援をご検討ください。

- **[Buy Me a Coffee](https://buymeacoffee.com/brightryog)** — グローバル・アカウント不要・$3〜
- **[BOOTH](https://brightryo.booth.pm/items/8414334)** — PayPay・コンビニ・クレジットカード対応・¥300〜
- **[GitHub Sponsors](https://github.com/sponsors/brightryo)** — 月額・単発どちらも可能・GitHub アカウント必要

## 不具合報告・要望

バグ報告や機能要望は [GitHub Issues](https://github.com/brightryo/mojioko/issues) からお願いします。

## ライセンス

プロプライエタリ。詳細は [LICENSE](build/license_ja.txt) をご確認ください。

Copyright © 2026 brightryo. All rights reserved.

---

## 補足事項

- **SmartScreen 警告について**: v1.0.0 のインストーラはコード署名されていません。初回起動時に Windows Defender SmartScreen の警告が表示される場合があります。今後のバージョンで対応予定です。
- **自動更新**: 自動更新機能は実装していません。ヘルプ → ダウンロードページを開く から手動で確認できます。
- **macOS / Linux**: 現在は Windows のみ対応です。
