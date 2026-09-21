# Club One Bot v2

Cloudflare Workers + Discord Interactions + KV のゼロベース版です。

## 必須環境変数

- `DISCORD_PUBLIC_KEY`
- `DISCORD_APPLICATION_ID`
- `DISCORD_GUILD_ID`
- `DISCORD_TOKEN`

KV Binding:
- `APP_KV`

## Discordロール

初期値として既存の以下を利用できます。

- メンバー: `1200600144597495879`
- サポート: `1212433528793473096`
- 「本日参加候補」: ロール名から自動検索（設定でID固定も可能）

運営ロールは `/settings` で指定できます。未指定なら Administrator を運営扱いします。

## 初回セットアップ

1. Workerをデプロイ
2. Secrets/Variables に上記環境変数を設定
3. KV Binding `APP_KV` を接続
4. `GET /register-commands` を一度実行してGuildコマンドを登録
5. Discordで `/settings` を実行し、3チャンネルとロールを設定
6. `/weekly` または `/admin` で動作確認

## 自動処理

Cronは毎分起動し、KVの設定時刻とJSTを比較します。
そのため週予定開始、未登録リマインド、当日確認DMの時刻をDiscordから変更できます。

## 注意

このv2は今回確定した運用を中心にゼロベースで整理した版です。
スタメン画像のPNG生成は、Cloudflare Worker単体で外部画像ライブラリを追加せずに動かせる範囲では、まず配置データ保存を実装しています。実際のPNGレンダリングは画像生成方式（WASM等）を追加する段階で実装します。
