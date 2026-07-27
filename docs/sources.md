# データソース台帳

収集しているソースと、その利用条件をここに集約する。
**新しいソースを足すときは「利用規約の確認 → この表に追記 → 実装」の順を必ず踏む。**
規約確認前のスクレイピングは一切しない。

## 現在収集しているソース

出典はすべて **気象庁**。気象庁ホームページのコンテンツは
[政府標準利用規約（第2.0版）](https://www.jma.go.jp/jma/kishou/info/coment.html) に準拠し、
出典を明記すれば二次利用できる（商用利用を含む）。規約リスクなし。

| # | データ | エンドポイント | 頻度 | 保存先 |
|---|---|---|---|---|
| 1 | 現存台風の一覧 | `https://www.jma.go.jp/bosai/typhoon/data/targetTc.json` | 毎時 | `data/typhoon/` |
| 2 | 台風の諸元（実況＋120時間先までの予報） | `https://www.jma.go.jp/bosai/typhoon/data/{tc}/specifications.json` | 毎時（発表更新時のみ記録） | `data/typhoon/` |
| 3 | 台風の図形（予報円・暴風警戒域） | `https://www.jma.go.jp/bosai/typhoon/data/{tc}/forecast.json` | 毎時（発表更新時のみ記録） | `data/typhoon/` |
| 4 | 気象警報・注意報（沖縄4区） | `https://www.jma.go.jp/bosai/warning/data/warning/{471000,472000,473000,474000}.json` | 毎時（発表更新時のみ記録） | `data/warning/` |
| 5 | アメダス最新観測時刻 | `https://www.jma.go.jp/bosai/amedas/data/latest_time.txt` | 毎時 | （#6 のURL組み立てに使うだけ） |
| 6 | アメダス実況（沖縄34地点） | `https://www.jma.go.jp/bosai/amedas/data/map/{yyyyMMddHHmmss}.json` | 毎時 | `data/amedas/` |
| 7 | アメダス日値（官署8地点） | `https://www.jma.go.jp/bosai/amedas/data/point/{id}/{yyyyMMdd}_21.json` | 日次 | `data/amedas_daily/` |

### 参照用の定数ファイル（収集対象ではない）

コード表を人間が引くときに使う。定期取得はしない。

- 地域コード階層: `https://www.jma.go.jp/bosai/common/const/area.json`
- アメダス地点表: `https://www.jma.go.jp/bosai/amedas/const/amedastable.json`

## 実測でわかっている注意点（2026-07-27 M1 実測）

- **これらの JSON は公開されているが非公式**（気象庁が API として仕様を約束しているものではない）。
  仕様変更・廃止があり得る。だから取得失敗を必ず検知して落とす設計にしてある。
- **警報 JSON は発表内容に変化があったときしか更新されない。**
  M1 実測時点で沖縄4区の `Last-Modified` は2ヶ月前のままだった（＝発表なしの状態が続いている）。
  「更新がない」は異常ではない。異常判定は HTTP ステータスとパース可否だけで行う。
- 全エンドポイントに `ETag` と `Cache-Control: max-age=60` がある。警報は条件付き GET
  （`If-None-Match`）で 304 を受けられるので、平時の転送量はほぼゼロ。
- 警報コードの公式な対応表は JSON では配信されていない
  （`common/const/warningcode.json` は 404）。コードは生のまま保存し、
  対応表は [README.md](../README.md) に手書きで持つ。
- 台風の詳細ファイルは `specifications.json` と `forecast.json` の2本だけ。
  `detail.json` / `overview.json` / `track.json` は存在しない（404 実測済み）。

## 見送ったソース

| ソース | 状況 |
|---|---|
| 海面水温 | bosai 系に JSON が見当たらず、`data.jma.go.jp` 側の推測パスはすべて 404。画像・別系統の可能性が高い。MVP の成立条件ではないので M3 以降の調査項目として切り出す。 |
| 潮位 | 同上。 |

## 追加を検討しているソース（**規約確認が済むまで着手しない**）

| ソース | 確認すべきこと |
|---|---|
| 停電情報（沖縄電力） | 利用規約・robots.txt。二次利用の可否 |
| フェリー・航空の欠航情報 | 各社の利用規約。ほぼ個別確認が必要 |
| 宿泊税・ホテル税制度 | 自治体サイトの利用条件 |
