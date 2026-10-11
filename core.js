// 画面に依存しないロジック（検証・集計・取り込み・書き出し）
// 理由: DOM から切り離して Node のテスト（tests/core.test.js）で全分岐を確認できるようにするため
(function (root) {
  "use strict";

  // ---- ログ ----
  // 理由: 共通ルール「すべての動作をログに記録」「空の分岐には trace ログ」に従うため。
  //       本番では warn 以上だけ出し、調べるときは localStorage の ap_log_level を "trace" にする
  const LOG_LEVELS = { trace: 0, debug: 1, info: 2, warn: 3, error: 4 };

  function createLogger(level) {
    const logger = { level: level in LOG_LEVELS ? level : "warn" };
    for (const name of Object.keys(LOG_LEVELS)) {
      logger[name] = function (...args) {
        if (LOG_LEVELS[name] >= LOG_LEVELS[logger.level]) {
          const out = name === "trace" ? "debug" : name;
          // 出力先は開発者ツールのコンソール（端末内のみ。外部送信はしない）
          console[out]("[ap-qa]", ...args);
        } else {
          // 設定レベル未満のログは出さない
        }
      };
    }
    return logger;
  }

  const logger = createLogger("warn");

  // ---- 定数 ----
  const APP_ID = "ap-qa";
  const EXPORT_VERSION = 1;
  const TYPES = ["desc", "ox", "choice"];
  const TYPE_LABELS = { desc: "一問一答", ox: "○×", choice: "選択" };
  const MIN_CHOICES = 2;
  const MAX_CHOICES = 6;
  // 本試験と同じく選択肢は ア〜エ（最大6個なので オ・カ まで）
  const CHOICE_LABELS = ["ア", "イ", "ウ", "エ", "オ", "カ"];
  const OX_TRUE = [true, "true", "○", "〇", "o", "O"];
  const OX_FALSE = [false, "false", "×", "✕", "x", "X"];

  // ---- 目次 ----

  /** 節コード → { code, title, key, subjectB, chapter, order } の Map を作る */
  function buildSectionMap(chapters) {
    const map = new Map();
    let order = 0;
    for (const ch of chapters) {
      for (const sec of ch.sections) {
        map.set(sec.code, Object.assign({}, sec, { chapter: ch, order: order++ }));
      }
    }
    return map;
  }

  // ---- ID ----

  /** 時刻＋乱数の短いID。理由: 端末をまたいで書き出し・取り込みしても衝突しにくくするため */
  function generateId(now, rand) {
    const t = (now === undefined ? Date.now() : now).toString(36);
    const r = Math.floor((rand === undefined ? Math.random() : rand) * 36 ** 6).toString(36).padStart(6, "0");
    return "q" + t + r;
  }

  // ---- 問題の検証 ----

  function toText(v) {
    if (typeof v === "string") {
      return v.trim();
    } else if (typeof v === "number" && Number.isFinite(v)) {
      return String(v);
    } else {
      return "";
    }
  }

  function parseOx(v) {
    if (OX_TRUE.includes(v)) {
      return true;
    } else if (OX_FALSE.includes(v)) {
      return false;
    } else {
      return null;
    }
  }

  /**
   * 1問を検証して正規化する。
   * options.allowNewId: id がないとき新しく振る（取り込み時）。false なら id なしは不正
   * 戻り値: { ok: true, question } または { ok: false, reason }
   */
  function normalizeQuestion(raw, sectionMap, options) {
    const opts = options || {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return { ok: false, reason: "問題がオブジェクトではありません" };
    } else {
      logger.trace("normalizeQuestion: object", raw.id);
    }

    let id = typeof raw.id === "string" ? raw.id.trim() : "";
    if (!id) {
      if (opts.allowNewId) {
        id = generateId(opts.now);
      } else {
        return { ok: false, reason: "IDがありません" };
      }
    } else {
      logger.trace("normalizeQuestion: id あり");
    }

    const section = toText(raw.section);
    if (!sectionMap.has(section)) {
      return { ok: false, reason: `節コード「${section}」が目次にありません` };
    } else {
      logger.trace("normalizeQuestion: section ok", section);
    }

    const type = raw.type === undefined || raw.type === null || raw.type === "" ? "desc" : raw.type;
    if (!TYPES.includes(type)) {
      return { ok: false, reason: `形式「${type}」は使えません（desc / ox / choice）` };
    } else {
      logger.trace("normalizeQuestion: type ok", type);
    }

    const question = toText(raw.question);
    if (!question) {
      return { ok: false, reason: "問題文がありません" };
    } else {
      logger.trace("normalizeQuestion: question ok");
    }

    const q = { id, section, type, question };

    switch (type) {
      case "desc": {
        const answer = toText(raw.answer);
        if (!answer) {
          return { ok: false, reason: "解答がありません" };
        } else {
          q.answer = answer;
        }
        break;
      }
      case "ox": {
        const answer = parseOx(raw.answer);
        if (answer === null) {
          return { ok: false, reason: "○×の解答は true（○）か false（×）にしてください" };
        } else {
          q.answer = answer;
        }
        break;
      }
      case "choice": {
        if (!Array.isArray(raw.choices)) {
          return { ok: false, reason: "選択肢（choices）がありません" };
        } else {
          logger.trace("normalizeQuestion: choices は配列");
        }
        const choices = raw.choices.map(toText);
        if (choices.length < MIN_CHOICES || choices.length > MAX_CHOICES) {
          return { ok: false, reason: `選択肢は${MIN_CHOICES}〜${MAX_CHOICES}個にしてください` };
        } else if (choices.some((c) => !c)) {
          return { ok: false, reason: "空の選択肢があります" };
        } else {
          q.choices = choices;
        }
        const answer = typeof raw.answer === "string" && raw.answer.trim() !== "" ? Number(raw.answer) : raw.answer;
        if (!Number.isInteger(answer) || answer < 0 || answer >= choices.length) {
          return { ok: false, reason: "正解の選択肢番号（0始まり）が範囲外です" };
        } else {
          q.answer = answer;
        }
        break;
      }
      default:
        // [カバレッジ除外] 直前で TYPES 以外を弾いているため到達しない（形式を追加したときの保険）
        return { ok: false, reason: "不明な形式です" };
    }

    q.explanation = toText(raw.explanation);
    q.createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : (opts.now === undefined ? Date.now() : opts.now);
    if (Number.isFinite(raw.updatedAt)) {
      q.updatedAt = raw.updatedAt;
    } else {
      logger.trace("normalizeQuestion: updatedAt なし");
    }
    if (Number.isFinite(raw.deletedAt)) {
      q.deletedAt = raw.deletedAt;
    } else {
      logger.trace("normalizeQuestion: deletedAt なし");
    }
    return { ok: true, question: q };
  }

  /** 配列をまとめて検証。不正な行は理由付きで skipped に入れる */
  function normalizeList(list, sectionMap, options) {
    const questions = [];
    const skipped = [];
    if (!Array.isArray(list)) {
      return { questions, skipped: [{ index: -1, reason: "問題の配列ではありません" }] };
    } else {
      logger.trace("normalizeList: 件数", list.length);
    }
    list.forEach((raw, index) => {
      const r = normalizeQuestion(raw, sectionMap, options);
      if (r.ok) {
        questions.push(r.question);
      } else {
        skipped.push({ index, reason: r.reason });
      }
    });
    return { questions, skipped };
  }

  // ---- 学習記録 ----

  function normalizeRecords(raw) {
    const out = {};
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      return out;
    } else {
      logger.trace("normalizeRecords: object");
    }
    for (const [id, rec] of Object.entries(raw)) {
      if (rec && Number.isInteger(rec.correct) && Number.isInteger(rec.wrong) && rec.correct >= 0 && rec.wrong >= 0) {
        out[id] = { correct: rec.correct, wrong: rec.wrong };
      } else {
        logger.warn("学習記録の不正な行を無視", id);
      }
    }
    return out;
  }

  /** 不正解1回以上かつ 不正解数 ≥ 正解数 */
  function isWeak(rec) {
    return Boolean(rec) && rec.wrong >= 1 && rec.wrong >= rec.correct;
  }

  function isStudied(rec) {
    return Boolean(rec) && rec.correct + rec.wrong > 0;
  }

  function recordAnswer(records, id, correct) {
    const rec = records[id] || { correct: 0, wrong: 0 };
    const next = correct ? { correct: rec.correct + 1, wrong: rec.wrong } : { correct: rec.correct, wrong: rec.wrong + 1 };
    return Object.assign({}, records, { [id]: next });
  }

  /** 問題リストの集計。rate は解答回数ベースの正答率（未解答なら null） */
  function summarize(list, records) {
    let studied = 0;
    let weak = 0;
    let correct = 0;
    let total = 0;
    for (const q of list) {
      const rec = records[q.id];
      if (isStudied(rec)) {
        studied++;
        correct += rec.correct;
        total += rec.correct + rec.wrong;
      } else {
        logger.trace("summarize: 未学習", q.id);
      }
      if (isWeak(rec)) {
        weak++;
      } else {
        logger.trace("summarize: 苦手ではない", q.id);
      }
    }
    return { count: list.length, studied, weak, rate: total > 0 ? correct / total : null };
  }

  function formatRate(rate) {
    if (rate === null) {
      return "—";
    } else {
      return Math.round(rate * 100) + "%";
    }
  }

  // ---- 共通問題と自作問題の合成 ----

  /**
   * 表示する問題の一覧（教材順）。
   * 同じIDが両方にあれば共通を表示し、自作側は隠す（共通に取り込み済みとみなす）。論理削除済みの自作は除く
   */
  function mergeQuestions(shared, own, sectionMap) {
    const sharedIds = new Set(shared.map((q) => q.id));
    const list = shared.map((q) => Object.assign({}, q, { source: "shared" }));
    for (const q of own) {
      if (q.deletedAt) {
        logger.trace("mergeQuestions: 論理削除済み", q.id);
      } else if (sharedIds.has(q.id)) {
        logger.trace("mergeQuestions: 共通に取り込み済み", q.id);
      } else {
        list.push(Object.assign({}, q, { source: "own" }));
      }
    }
    return sortByTextbook(list, sectionMap);
  }

  function sortByTextbook(list, sectionMap) {
    return list.slice().sort((a, b) => {
      const sa = sectionMap.get(a.section);
      const sb = sectionMap.get(b.section);
      const oa = sa ? sa.order : Number.MAX_SAFE_INTEGER;
      const ob = sb ? sb.order : Number.MAX_SAFE_INTEGER;
      if (oa !== ob) {
        return oa - ob;
      } else if (a.createdAt !== b.createdAt) {
        return (a.createdAt || 0) - (b.createdAt || 0);
      } else {
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
      }
    });
  }

  /** 出題範囲：scope が own なら自作のみ */
  function filterScope(list, scope) {
    if (scope === "own") {
      return list.filter((q) => q.source === "own");
    } else {
      return list;
    }
  }

  function shuffle(arr, rand) {
    const r = rand || Math.random;
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(r() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // ---- 書き出し・読み込み ----

  /** 書き出し：共通に取り込み済み・論理削除済みを除いた自作問題＋全学習記録 */
  function buildExport(own, sharedIds, records, now) {
    const ids = sharedIds instanceof Set ? sharedIds : new Set(sharedIds);
    return {
      app: APP_ID,
      version: EXPORT_VERSION,
      exportedAt: new Date(now === undefined ? Date.now() : now).toISOString(),
      questions: own.filter((q) => !q.deletedAt && !ids.has(q.id)),
      records: records
    };
  }

  /**
   * 読み込んだ JSON を解釈する。
   * 形式は ①書き出し形式 { app, questions, records } ②問題の配列だけ の2つ
   * 戻り値: { ok: true, kind, questions, records, skipped } / { ok: false, reason }
   */
  function parseImport(data, sectionMap, now) {
    if (Array.isArray(data)) {
      const r = normalizeList(data, sectionMap, { allowNewId: true, now });
      return { ok: true, kind: "array", questions: r.questions, records: {}, skipped: r.skipped };
    } else if (data && typeof data === "object" && Array.isArray(data.questions)) {
      if (data.app !== undefined && data.app !== APP_ID) {
        return { ok: false, reason: `別のアプリ（${data.app}）の書き出しファイルです` };
      } else {
        logger.trace("parseImport: app 一致または省略");
      }
      const r = normalizeList(data.questions, sectionMap, { allowNewId: true, now });
      return { ok: true, kind: "backup", questions: r.questions, records: normalizeRecords(data.records), skipped: r.skipped };
    } else {
      return { ok: false, reason: "このアプリの書き出しファイル、または問題の配列ではありません" };
    }
  }

  /** 自作問題へ取り込む：同じIDは上書き（論理削除も解除）、それ以外は追加 */
  function applyImport(own, imported) {
    const byId = new Map(own.map((q) => [q.id, q]));
    let added = 0;
    let updated = 0;
    for (const q of imported) {
      if (byId.has(q.id)) {
        updated++;
      } else {
        added++;
      }
      const copy = Object.assign({}, q);
      delete copy.deletedAt;
      byId.set(q.id, copy);
    }
    return { own: Array.from(byId.values()), added, updated };
  }

  /** 学習記録の取り込み：書き出しファイル側の値で上書き */
  function mergeRecords(current, imported) {
    return Object.assign({}, current, imported);
  }

  // ---- 学習計画表との連携 ----

  function parseLocalDate(text) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    if (m) {
      return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    } else {
      return null;
    }
  }

  function formatDate(d, sep) {
    const s = sep === undefined ? "/" : sep;
    return d.getFullYear() + s + String(d.getMonth() + 1).padStart(2, "0") + s + String(d.getDate()).padStart(2, "0");
  }

  /** 今日以降でいちばん近い試験。当日は days = 0。すべて終わっていれば null */
  function nextExam(exams, today) {
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let best = null;
    for (const ex of exams) {
      const d = parseLocalDate(ex.date);
      if (!d) {
        logger.warn("試験日の形式が不正", ex.date);
        continue;
      } else {
        logger.trace("nextExam: 日付 ok", ex.date);
      }
      const days = Math.round((d - base) / 86400000);
      if (days >= 0 && (best === null || days < best.days)) {
        best = { name: ex.name, date: ex.date, days };
      } else {
        logger.trace("nextExam: 過去または遠い試験", ex.name);
      }
    }
    return best;
  }

  /**
   * 学習計画表の「学習記録」シートに貼る1行（タブ区切り）。
   * 列：日付・時間(h)・分野・やったこと・問数・正解。時間と分野は本人が入れるので空欄
   */
  function buildRecordLine(date, title, count, correct) {
    return [formatDate(date), "", "", "一問一答アプリ " + title, String(count), String(correct)].join("\t");
  }

  const api = {
    LOG_LEVELS, createLogger, logger,
    APP_ID, EXPORT_VERSION, TYPES, TYPE_LABELS, MIN_CHOICES, MAX_CHOICES, CHOICE_LABELS,
    buildSectionMap, generateId, normalizeQuestion, normalizeList, normalizeRecords,
    isWeak, isStudied, recordAnswer, summarize, formatRate,
    mergeQuestions, sortByTextbook, filterScope, shuffle,
    buildExport, parseImport, applyImport, mergeRecords,
    parseLocalDate, formatDate, nextExam, buildRecordLine
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    // [カバレッジ除外] ブラウザでの読み込み経路。Node のテストでは通らない（画面テスト tests/app.test.js で確認）
    root.Core = api;
  }
})(typeof self !== "undefined" ? self : this);
