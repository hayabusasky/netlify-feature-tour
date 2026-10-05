# SNS運用チーム

Claude Code のサブエージェントとして定義した SNS 運用メンバーです。
定義ファイルは `.claude/agents/` にあります。

| メンバー | エージェント名 | 担当 | 成果物の保存先 |
|---|---|---|---|
| リサーチ | `sns-researcher` | トレンド・競合・ハッシュタグ調査 | `sns/research/` |
| 投稿作成 | `sns-writer` | 投稿文・台本・投稿カレンダー | `sns/posts/` |
| 動画編集 | `sns-video-editor` | クリップ結合・カット・書き出し（ffmpeg） | `sns/videos/output/` |
| テロップ | `sns-telop-creator` | 字幕・テロップ（SRT / ASS） | `sns/telop/` |
| PDCA | `sns-pdca-checker` | 数値分析・振り返り・改善提案 | `sns/reports/` |

## 基本の流れ

```
リサーチ → 投稿作成（台本） → 動画編集 ⇄ テロップ → 投稿 → PDCAチェック → リサーチへ
```

## 使い方

Claude Code で、メンバー名を指定して依頼します。

- 「sns-researcher で、20代女性向けの朝活ネタのトレンドを調べて」
- 「sns-writer で、最新のリサーチから Instagram リール用の台本を2案作って」
- 「sns-video-editor で、`sns/videos/raw/` のクリップを順番につないで縦型にして」
- 「sns-telop-creator で、さっきの台本のテロップを作って」
- 「sns-pdca-checker で、`sns/metrics/` の今週の数値を振り返って」

まとめて「リサーチから台本作成まで進めて」と頼めば、メインの Claude が順番にメンバーへ振り分けます。

## フォルダ

- `sns/videos/raw/` … 動画素材を置く場所（元素材は編集担当が上書きしません）
- `sns/metrics/` … 各SNSからエクスポートした数値CSVを置く場所
