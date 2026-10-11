// 教材の目次：『令和08年 応用情報技術者 合格教本』（技術評論社）11章81節
// 理由: 問題の section はこの節コードで教材に紐づける。目次にない節コードの問題は読み込み時にスキップされる
// key = 重点節（★）、subjectB = 対応する科目Bの問。学習計画表の「合格教本_目次」シートと同じ内容
// 注意: CHAPTERS は tools/merge_shared.py が JSON として読むため、キーは二重引用符・末尾カンマなしで書くこと

const FIELDS = [
  { id: "tech", name: "テクノロジ系" },
  { id: "mgmt", name: "マネジメント系" },
  { id: "strat", name: "ストラテジ系" }
];

// 科目Bの選択方針（学習計画表の「出題傾向_科目B詳細」シートと同じ）
// 理由: 節の一覧で、その節がどの程度科目Bに効くかを一目で分かるようにするため
const SUBJECT_B_POLICY = {
  "問1 情報セキュリティ": "必須",
  "問2 経営戦略": "主力候補",
  "問6 データベース": "主力候補",
  "問8 情報システム開発": "予備",
  "問9 プロジェクトマネジメント": "主力",
  "問10 サービスマネジメント": "主力",
  "問11 システム監査": "主力"
};

// 受験予定日（学習計画表の「概要」シートの受験予定日）。ホームに次の試験までの日数を出す
// 受験日を変えたらここを直して sw.js の CACHE_NAME を上げる
const EXAMS = [
  { name: "前期 科目A", date: "2026-11-08" },
  { name: "前期 科目B", date: "2026-12-06" },
  { name: "後期 科目A", date: "2027-02-14" },
  { name: "後期 科目B", date: "2027-03-14" }
];

const CHAPTERS = [
  { "no": 1, "title": "基礎理論", "field": "tech", "sections": [
    { "code": "1.1", "title": "集合と論理" },
    { "code": "1.2", "title": "情報量と符号化", "key": true },
    { "code": "1.3", "title": "オートマトン" },
    { "code": "1.4", "title": "形式言語" },
    { "code": "1.5", "title": "グラフ理論" },
    { "code": "1.6", "title": "確率と統計", "key": true },
    { "code": "1.7", "title": "回帰分析" },
    { "code": "1.8", "title": "数値計算" },
    { "code": "1.9", "title": "AI（人工知能）" }
  ] },
  { "no": 2, "title": "アルゴリズムとプログラミング", "field": "tech", "sections": [
    { "code": "2.1", "title": "リスト" },
    { "code": "2.2", "title": "スタックとキュー" },
    { "code": "2.3", "title": "木構造" },
    { "code": "2.4", "title": "探索アルゴリズム" },
    { "code": "2.5", "title": "整列アルゴリズム" },
    { "code": "2.6", "title": "再帰法" },
    { "code": "2.7", "title": "プログラム言語" }
  ] },
  { "no": 3, "title": "ハードウェアとコンピュータ構成要素", "field": "tech", "sections": [
    { "code": "3.1", "title": "ハードウェア" },
    { "code": "3.2", "title": "プロセッサアーキテクチャ" },
    { "code": "3.3", "title": "プロセッサの高速化技術", "key": true },
    { "code": "3.4", "title": "メモリアーキテクチャ" },
    { "code": "3.5", "title": "入出力アーキテクチャ" }
  ] },
  { "no": 4, "title": "システム構成要素", "field": "tech", "sections": [
    { "code": "4.1", "title": "システムの処理形態" },
    { "code": "4.2", "title": "クライアントサーバシステム" },
    { "code": "4.3", "title": "システムの構成と信頼性設計" },
    { "code": "4.4", "title": "高信頼性・高性能システム" },
    { "code": "4.5", "title": "ストレージ関連技術" },
    { "code": "4.6", "title": "仮想化技術" },
    { "code": "4.7", "title": "システムの性能特性と評価", "key": true },
    { "code": "4.8", "title": "待ち行列理論の適用", "key": true },
    { "code": "4.9", "title": "システムの信頼性特性と評価", "key": true }
  ] },
  { "no": 5, "title": "ソフトウェア", "field": "tech", "sections": [
    { "code": "5.1", "title": "OSの構成と機能" },
    { "code": "5.2", "title": "タスク（プロセス）管理", "key": true },
    { "code": "5.3", "title": "記憶管理", "key": true },
    { "code": "5.4", "title": "言語処理ツール" },
    { "code": "5.5", "title": "開発ツール" },
    { "code": "5.6", "title": "UNIX系OS" }
  ] },
  { "no": 6, "title": "データベース", "field": "tech", "sections": [
    { "code": "6.1", "title": "データベース設計", "subjectB": "問6 データベース" },
    { "code": "6.2", "title": "関係データベース" },
    { "code": "6.3", "title": "正規化", "key": true },
    { "code": "6.4", "title": "関係データベースの演算" },
    { "code": "6.5", "title": "SQL", "key": true, "subjectB": "問6 データベース" },
    { "code": "6.6", "title": "データ定義言語" },
    { "code": "6.7", "title": "埋込み方式" },
    { "code": "6.8", "title": "データベース管理システム", "key": true },
    { "code": "6.9", "title": "分散データベース" },
    { "code": "6.10", "title": "データベース応用" },
    { "code": "6.11", "title": "ブロックチェーン" }
  ] },
  { "no": 7, "title": "ネットワーク", "field": "tech", "sections": [
    { "code": "7.1", "title": "通信プロトコルの標準化" },
    { "code": "7.2", "title": "ネットワーク接続装置と関連技術" },
    { "code": "7.3", "title": "データリンク層の制御とプロトコル" },
    { "code": "7.4", "title": "ネットワーク層のプロトコルと技術", "key": true },
    { "code": "7.5", "title": "トランスポート層のプロトコル", "key": true },
    { "code": "7.6", "title": "アプリケーション層のプロトコル", "key": true },
    { "code": "7.7", "title": "ネットワークの仮想化技術" },
    { "code": "7.8", "title": "無線LAN" },
    { "code": "7.9", "title": "通信規格・通信技術" }
  ] },
  { "no": 8, "title": "セキュリティ", "field": "tech", "sections": [
    { "code": "8.1", "title": "暗号化" },
    { "code": "8.2", "title": "無線LANの暗号" },
    { "code": "8.3", "title": "認証", "key": true },
    { "code": "8.4", "title": "デジタル署名とPKI", "key": true },
    { "code": "8.5", "title": "セキュリティ実装技術" },
    { "code": "8.6", "title": "情報セキュリティの脅威と攻撃手法", "key": true, "subjectB": "問1 情報セキュリティ" },
    { "code": "8.7", "title": "情報セキュリティ管理", "subjectB": "問1 情報セキュリティ" }
  ] },
  { "no": 9, "title": "システム開発技術", "field": "tech", "sections": [
    { "code": "9.1", "title": "開発プロセス・手法" },
    { "code": "9.2", "title": "分析・設計手法", "subjectB": "問8 情報システム開発" },
    { "code": "9.3", "title": "オブジェクト指向設計", "key": true },
    { "code": "9.4", "title": "モジュール設計" },
    { "code": "9.5", "title": "テスト", "key": true, "subjectB": "問8 情報システム開発" },
    { "code": "9.6", "title": "テスト管理手法" },
    { "code": "9.7", "title": "レビュー" }
  ] },
  { "no": 10, "title": "マネジメント", "field": "mgmt", "sections": [
    { "code": "10.1", "title": "プロジェクトマネジメント", "subjectB": "問9 プロジェクトマネジメント" },
    { "code": "10.2", "title": "スケジュールマネジメントで用いる手法", "key": true, "subjectB": "問9 プロジェクトマネジメント" },
    { "code": "10.3", "title": "コストマネジメントで用いる手法", "key": true, "subjectB": "問9 プロジェクトマネジメント" },
    { "code": "10.4", "title": "サービスマネジメント", "subjectB": "問10 サービスマネジメント" },
    { "code": "10.5", "title": "システム監査", "key": true, "subjectB": "問11 システム監査" }
  ] },
  { "no": 11, "title": "ストラテジ", "field": "strat", "sections": [
    { "code": "11.1", "title": "システム戦略", "key": true },
    { "code": "11.2", "title": "経営戦略マネジメント", "key": true, "subjectB": "問2 経営戦略" },
    { "code": "11.3", "title": "ビジネスインダストリ" },
    { "code": "11.4", "title": "経営工学" },
    { "code": "11.5", "title": "企業会計", "key": true },
    { "code": "11.6", "title": "標準化と関連法規", "key": true }
  ] }
];
