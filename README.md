# Zenn公開記事

このPublicリポジトリは、Zennで公開している記事と読者からのPull Requestを管理します。

- 公開記事: [`articles/`](./articles)
- Zenn: [Yanchon918sの記事一覧](https://zenn.dev/yanchon918s)
- 執筆中の下書きと編集履歴: 別のPrivateリポジトリで管理

## 修正提案を歓迎します

誤字脱字、リンク切れ、技術的な誤り、説明の改善などはPull Requestで提案できます。
対象の記事ファイルを編集し、変更理由や根拠をPull Requestへ記載してください。

詳しい手順は[`CONTRIBUTING.md`](./CONTRIBUTING.md)をご覧ください。

## ローカルプレビュー

```powershell
npm install
npx zenn preview
```

このリポジトリの`main`ブランチはZennのデプロイ対象です。マージされた変更はZennへ同期されます。

## CIとPrivate原本への反映

- すべてのPull Requestで、変更範囲、Front Matter、slug、参照画像、Zenn CLIの検証を行います。
- 読者のPull Requestを`main`へマージすると、Zennへデプロイされます。
- Private執筆リポジトリはPublicの`main`を定期確認し、差分があればPrivate側へ同期Pull Requestを作成します。
- Private側で公開対象になった記事は、`sync/private-main`ブランチからこのリポジトリへ公開Pull Requestとして届きます。

相互同期は`main`へ直接書き込まず、必ずPull Requestで内容を確認してからマージします。
