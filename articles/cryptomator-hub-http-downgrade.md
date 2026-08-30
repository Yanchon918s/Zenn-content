---
title: 春休みなので脆弱性報告したらCVEついた話 day1 (CVE-2026-32309)
type: tech
topics:
  - security
  - oauth
  - java
  - cve
  - cryptomator
emoji: 🔓
published: true
---

## はじめに
本記事は[CVE-2026-32309](https://github.com/cryptomator/cryptomator/security/advisories/GHSA-vv33-h7qx-c264)として公開されており、Cryptomator `1.19.1` より修正が適用されています。
セキュリティ初学者の視点で書いていますので、説明や公開方法について不適切な点があればコメント等でご指摘いただけると幸いです。

## なぜCVEを取りたいと思ったのか
私は27年卒予定の学生で26年4月現在絶賛就活中なのですが、開発やネットワークの経験を説明するときにOSSのコントリビュート経験がなく、これから作るにも時間が確保できるかわからないということで「脆弱性の指摘であればトリアージまでの時間がOSSのPRより早く、ついでにセキュリティの勉強にもなるし、しかも**非公開**で報告できる(=公開 Issue と違って失敗しても外から見えない)」と思い挑戦しました

## なにから手を付けたのか
CVEを取るといっても、そもそもCVEがどのようにして発行されるかあまり詳しくありませんでした。
「GHSA経由で脆弱性の報告を行った際にCVEが採番された」という情報をいくつかの記事で見つけ、「これなら自分もできるかもしれない」と思いました。

また、できる限り手を付ける製品は自分の手元にあるものでコードが読めるものが良いと思い、私のPCにインストールされているCryptomatorが今回の対象となりました。


## どこから読んでいったのか

コードを読むにあたっては「外部から入ってくる値が、検証されないまま使われる場所」を最初に探すことに決め、`KeyLoadingStrategy` の周辺から読み始めました
Cryptomator は鍵の取り出し方が複数用意されていて、Hub はそのうちの「中央サーバから鍵を取得する」ルートです。ネットワークが絡むのはここなので、最初に読むならここだろうと思って開きました。

`HubKeyLoadingStrategy.java` を開いた瞬間、`hub+http` と `hub+https` が **両方** 正規スキームとして並んでいるのが目に入りました。普通にバインドされているのか、それとも別フラグでガードされているのか分からなかったので、続けて Dagger モジュール (`HubKeyLoadingModule`) を見に行きました。

`@IntoMap` の `@StringKey` で **両方とも普通にバインド** されていました。フラグなし、条件なしです。

「私の理解が浅いだけで、これは実は安全な実装なのでは？」と疑って、`package-info.java` まで戻って読みました(翻訳機越しなのでニュアンスが違っていたら申し訳ないです)。

> Hub への OAuth 開始時、vault に埋め込まれた **HTTP** アドレスをブラウザで開く。

仕様、でした。

## 通信処理がどうなっていたか

スキームの話はこれで分かったので、エンドポイントを実際に通信に使っている場所を見に行きました。`AuthFlowTask.java` の認可リクエスト組み立て部分です ([1.19.0 該当箇所](https://github.com/cryptomator/cryptomator/blob/3a58f560fcf230b4f33fe1c21cb39f2db089a108/src/main/java/org/cryptomator/ui/keyloading/hub/AuthFlowTask.java#L35-L46))。

```java
var response = TinyOAuth2.client(hubConfig.clientId) //
		.withTokenEndpoint(URI.create(hubConfig.tokenEndpoint)) //
		.withRequestTimeout(Duration.ofSeconds(10)) //
		.authorizationCodeGrant(URI.create(hubConfig.authEndpoint)) //
		.setSuccessResponse(Response.redirect(URI.create(hubConfig.authSuccessUrl + "&device=" + authFlowContext.deviceId()))) //
		.setErrorResponse(Response.redirect(URI.create(hubConfig.authErrorUrl + "&device=" + authFlowContext.deviceId()))) //
		.authorize(HttpClient.newHttpClient(), redirectUriConsumer);
```

`hubConfig` は vault のメタデータから来ます。つまり vault を作る側が好きに値を入れられる場所です。それなのにこのコードを読む限り

- スキームのチェックがない
- origin のチェックがない
- `authEndpoint` と `tokenEndpoint` と `apiBaseUrl` が **同じ origin に属しているか** も見ていない

ということが分かりました。「ローカルアプリだから内部のデータは信頼していい」という前提が、**vault 設定が外から来る時点で崩れている**、というのが私の結論です。

## どんな攻撃が成立するか

ここまで読めれば、悪意ある vault を被害者が開いた時に何が起きるかは想像しやすくなります。

- OAuth 認可のリダイレクトが平文 HTTP に引きずり下ろされる
- bearer token が平文 HTTP に乗る
- device registration の宛先が攻撃者の指す先になる
- API ベースが攻撃者ホストに差し替わる

「`https` なら TLS で守られるはず」というのは TLS の仕事の話であって、**そもそも URL を攻撃者が選べる時点で、TLS が守る通信は「攻撃者と被害者の通信」になってしまいます**。守るべき相手を間違えている、と言ったほうが正確かもしれません。

もうひとつ気になったのが、`authEndpoint` と `tokenEndpoint` が **別オリジンでも通る** ところです。auth は本物の Hub に向かわせて token だけ自分のサーバに引き込む、という OAuth mix-up attack に類する手口が理屈上できそうでした。

## 自分のコードを思い出した話

書きながら少し怖くなってきたのが、これは結局「設定値・ペイロード・メタデータから取り出した URL を、検証なしで `URI.create()` して通信に使う」という話で、自分が書いたコードに思い当たる節が多いということでした。

過去のサービスで、私は「ユーザーが登録したコールバック URL」を OAuth のリダイレクトに足したことがあります。チェックは「`https://` で始まるか」だけでした。今思うと

- スキームだけ見ても、ホストは別ドメインに飛ばせる
- 一見 `https` でも、IP リテラルや `[::]`、`@` を挟まれると挙動が変わる
- フィールドが複数あると、片方だけ検証して片方ザル、になりがち

このどれも踏みうる書き方をしていました。Cryptomator の場合は5フィールドあって **1個も検証されていない** ので、「コードがバグっていた」というより「設計の段階で Hub endpoint policy という概念がなかった」と言ったほうが近いと思います。

## 修正されたもの

GHSA に挙がっている修正方針はだいたいこんな感じです。

- 本番ビルドから `hub+http` を消す
- `authEndpoint` / `tokenEndpoint` / `apiBaseUrl` の `https` を強制
- 各エンドポイントが同じ origin に属することをチェック
- どうしても HTTP を残す必要があるなら開発者専用フラグ＋強い警告

`1.19.1` のリリースノートにも `Disallow unencrypted http connections to hub by default` と書かれています ([リリースページ](https://github.com/cryptomator/cryptomator/releases/tag/1.19.1))。直していただいてありがたいです。


## がんばったところ

以下の2つは、今回の報告で特にがんばったところです

**1. 報告の形式**

GHSA 経由で SECURITY.md のテンプレに沿って書きました。特に Affected Code はファイル名と行番号まで指定したので、メンテナ側はその場所を開くだけで確認できる状態にしました。
英語での報告も翻訳サイトとLLMのサイトを行き来しながら書いたので、内容が伝わるか不安でしたが、結果的に通ってよかったです。

**2. 再現手順を短く絞ったこと**

「悪意ある vault の `authEndpoint` などに非HTTPSのエンドポイントを埋め込み、それを開く」という4ステップの手順を提出しました。コードを読み込めば再現できる粒度で書き、実装そのものを辿れるようにしたつもりです。
粒度の"普通"がいまいちわからなかったのでHacker Oneのレポートや他のGHSAレポートを参考にしました。

**3. タイムラインの速さ**

これは私の手柄ではなくメンテナ側の仕事の速さなのですが、ざっくり以下のような流れでした。

- 2026-03-11: GHSA advisory 作成 (報告内容の受理)
- 2026-03-12: 1.19.1 リリース
- 2026-03-20: GHSA advisory 公開

「受理されるか不安」という時間がほとんどなく、初めて報告する人間にとってはありがたい体験でした。

---

## おわりに
正直、今回のCVEは運がよく、私の手元で動いているOSSかつコードが読めるものだったからこそ見つけられたものだと思います。もしこれが別のプロジェクトで、コードが読めない・動かせない環境だったら、見つけられなかった可能性も高いと思います。

これからもセキュリティの勉強(と英語の勉強の両方)を続けていきたいと思います。


参考:

- [GHSA-vv33-h7qx-c264](https://github.com/cryptomator/cryptomator/security/advisories/GHSA-vv33-h7qx-c264)
- [NVD - CVE-2026-32309](https://nvd.nist.gov/vuln/detail/CVE-2026-32309)
- [Cryptomator 1.19.1 Release Notes](https://github.com/cryptomator/cryptomator/releases/tag/1.19.1)
- [CWE-319: Cleartext Transmission of Sensitive Information](https://cwe.mitre.org/data/definitions/319.html)
- [RFC 9700: Best Current Practice for OAuth 2.0 Security](https://datatracker.ietf.org/doc/html/rfc9700)
