// 画面の表示と操作（ロジックは core.js、目次は chapters.js、共通問題は questions-shared.js）
(function () {
  "use strict";

  const APP_VERSION = "v1";
  const STORAGE_KEYS = { questions: "ap_questions", records: "ap_records", settings: "ap_settings", logLevel: "ap_log_level" };
  const DEFAULT_SETTINGS = { theme: "auto", randomCount: 10, scope: "all", lastSection: "", lastType: "desc", lastBackupAt: null };
  // 自作問題があるのにこの日数以上書き出していなければホームで知らせる
  // 理由: データは端末の中だけにあり、ホーム画面のアイコン削除などで消えるため
  const BACKUP_WARN_DAYS = 7;
  const DAY_MS = 86400000;
  const DEFAULT_CHOICE_COUNT = 4;
  const TOAST_MS = 2500;

  const logger = Core.logger;
  const sectionMap = Core.buildSectionMap(CHAPTERS);

  // ---- 状態 ----
  let shared = [];
  let own = [];
  // 読み込めなかった自作問題（目次にない節など）。保存時に消さないよう元の形のまま持っておく
  let ownInvalidRaw = [];
  let records = {};
  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let allQuestions = [];
  let byId = new Map();
  let persisted = false;

  let quiz = null;
  let editing = null;
  let listFilter = { range: "all", kind: "all", search: "" };

  // ---- 最外側のエラー処理 ----
  // 理由: 想定外のエラーでも画面に出して、黙って止まらないようにするため
  window.addEventListener("error", (e) => {
    logger.error("未処理のエラー", e.message, e.error);
    showToast("エラーが発生しました：" + e.message, true);
  });
  window.addEventListener("unhandledrejection", (e) => {
    logger.error("未処理の Promise エラー", e.reason);
    showToast("エラーが発生しました：" + (e.reason && e.reason.message ? e.reason.message : String(e.reason)), true);
  });

  // ---- 保存 ----

  function loadJson(key, fallback) {
    let raw;
    try {
      raw = localStorage.getItem(key);
    } catch (e) {
      logger.error("localStorage を読めません", key, e);
      return fallback;
    }
    if (raw === null) {
      return fallback;
    } else {
      logger.trace("loadJson: あり", key);
    }
    try {
      return JSON.parse(raw);
    } catch (e) {
      // 壊れたデータは消さずに別名で退避してから空で始める
      logger.error("保存データが壊れています", key, e);
      saveRaw(key + "_broken_" + Date.now(), raw);
      showToast("保存データの一部が壊れていたため退避しました（" + key + "）", true);
      return fallback;
    }
  }

  function saveRaw(key, text) {
    try {
      localStorage.setItem(key, text);
      return true;
    } catch (e) {
      logger.error("保存に失敗", key, e);
      showToast("保存できませんでした。端末の空き容量やプライベートブラウズを確認してください", true);
      return false;
    }
  }

  function saveJson(key, value) {
    return saveRaw(key, JSON.stringify(value));
  }

  function saveOwn() {
    return saveJson(STORAGE_KEYS.questions, own.concat(ownInvalidRaw));
  }

  function saveRecords() {
    return saveJson(STORAGE_KEYS.records, records);
  }

  function saveSettings() {
    return saveJson(STORAGE_KEYS.settings, settings);
  }

  function loadAll() {
    const levelRaw = (function () {
      try {
        return localStorage.getItem(STORAGE_KEYS.logLevel);
      } catch (e) {
        return null;
      }
    })();
    if (levelRaw && levelRaw in Core.LOG_LEVELS) {
      logger.level = levelRaw;
    } else {
      logger.trace("loadAll: ログレベルは既定");
    }

    const sharedRaw = typeof SHARED_QUESTIONS !== "undefined" ? SHARED_QUESTIONS : [];
    const s = Core.normalizeList(sharedRaw, sectionMap, { allowNewId: false });
    for (const sk of s.skipped) {
      logger.warn("共通問題をスキップ", sk.index, sk.reason);
    }
    shared = s.questions.map((q) => {
      const copy = Object.assign({}, q);
      delete copy.deletedAt;
      return copy;
    });

    const ownRaw = loadJson(STORAGE_KEYS.questions, []);
    const list = Array.isArray(ownRaw) ? ownRaw : [];
    own = [];
    ownInvalidRaw = [];
    list.forEach((raw) => {
      const r = Core.normalizeQuestion(raw, sectionMap, { allowNewId: false });
      if (r.ok) {
        own.push(r.question);
      } else {
        logger.warn("自作問題を読み込めません（保存はそのまま残す）", r.reason);
        ownInvalidRaw.push(raw);
      }
    });

    records = Core.normalizeRecords(loadJson(STORAGE_KEYS.records, {}));
    const st = loadJson(STORAGE_KEYS.settings, {});
    settings = Object.assign({}, DEFAULT_SETTINGS, st && typeof st === "object" ? st : {});
    refreshData();
  }

  function refreshData() {
    allQuestions = Core.mergeQuestions(shared, own, sectionMap);
    byId = new Map(allQuestions.map((q) => [q.id, q]));
  }

  /** 出題・集計に使う問題（設定の出題範囲を反映） */
  function pool() {
    return Core.filterScope(allQuestions, shared.length > 0 ? settings.scope : "all");
  }

  function ownVisible() {
    return own.filter((q) => !q.deletedAt);
  }

  // ---- DOM ヘルパー ----
  // 理由: 問題文などの入力値は必ず textContent で入れ、HTML として解釈させない（XSS 防止）

  function $(id) {
    return document.getElementById(id);
  }

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) {
        continue;
      } else if (k === "class") {
        el.className = v;
      } else if (k === "text") {
        el.textContent = v;
      } else if (k.startsWith("on")) {
        el.addEventListener(k.slice(2), v);
      } else if (v === true) {
        el.setAttribute(k, "");
      } else {
        el.setAttribute(k, String(v));
      }
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) {
        continue;
      } else if (typeof c === "string" || typeof c === "number") {
        el.appendChild(document.createTextNode(String(c)));
      } else {
        el.appendChild(c);
      }
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }
  }

  function setSegmented(container, attr, value) {
    for (const b of container.querySelectorAll("[" + attr + "]")) {
      b.setAttribute("aria-checked", b.getAttribute(attr) === String(value) ? "true" : "false");
    }
  }

  let toastTimer = null;
  function showToast(message, isError) {
    const t = $("toast");
    if (!t) {
      return;
    } else {
      logger.trace("showToast", message);
    }
    t.textContent = (isError ? "⚠ " : "") + message;
    t.classList.toggle("error", Boolean(isError));
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      t.hidden = true;
    }, isError ? TOAST_MS * 2 : TOAST_MS);
  }

  function sectionLabel(code) {
    const s = sectionMap.get(code);
    return s ? code + " " + s.title : code;
  }

  function formatDateTime(ms) {
    const d = new Date(ms);
    return Core.formatDate(d) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  function answerText(q) {
    switch (q.type) {
      case "desc":
        return q.answer;
      case "ox":
        return q.answer ? "〇" : "×";
      case "choice":
        return Core.CHOICE_LABELS[q.answer] + "　" + q.choices[q.answer];
      default:
        logger.warn("answerText: 不明な形式", q.type);
        return "";
    }
  }

  // ---- 画面切り替え ----

  let currentScreen = "home";

  function show(name) {
    for (const s of document.querySelectorAll(".screen")) {
      s.hidden = s.id !== "screen-" + name;
    }
    currentScreen = name;
    switch (name) {
      case "home":
        renderHome();
        break;
      case "chapters":
        renderChapters();
        break;
      case "list":
        renderList();
        break;
      case "settings":
        renderSettings();
        break;
      case "edit":
        if (!editing) {
          openEdit(null, "home");
          return;
        } else {
          logger.trace("show edit: 編集状態あり");
        }
        break;
      default:
        // 出題・結果・表示は開く関数側で描画済み
        logger.trace("show: 描画は呼び出し側", name);
        break;
    }
    window.scrollTo(0, 0);
  }

  function applyTheme() {
    if (settings.theme === "light" || settings.theme === "dark") {
      document.documentElement.setAttribute("data-theme", settings.theme);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
  }

  // ---- ホーム ----

  function statTile(label, value) {
    return h("div", { class: "stat" }, h("span", { class: "stat-value", text: value }), h("span", { class: "stat-label", text: label }));
  }

  function renderHome() {
    const p = pool();
    const sum = Core.summarize(p, records);

    const ex = Core.nextExam(EXAMS, new Date());
    const cd = $("exam-countdown");
    if (ex) {
      const d = Core.parseLocalDate(ex.date);
      const md = (d.getMonth() + 1) + "/" + d.getDate();
      cd.textContent = ex.days === 0 ? "今日は " + ex.name + " の試験日です" : ex.name + "（" + md + "）まで あと " + ex.days + " 日";
      cd.hidden = false;
    } else {
      cd.hidden = true;
    }

    const stats = $("home-stats");
    clear(stats);
    stats.append(
      statTile("問題数", String(sum.count)),
      statTile("学習済み", String(sum.studied)),
      statTile("正答率", Core.formatRate(sum.rate)),
      statTile("苦手", String(sum.weak))
    );

    const fs = $("field-stats");
    clear(fs);
    if (p.length > 0) {
      for (const f of FIELDS) {
        const list = p.filter((q) => sectionMap.get(q.section).chapter.field === f.id);
        const s = Core.summarize(list, records);
        fs.append(h("div", { class: "field-row" },
          h("span", { class: "field-name", text: f.name }),
          h("span", { class: "field-num", text: s.studied + "/" + s.count + "問" }),
          h("span", { class: "field-rate", text: Core.formatRate(s.rate) })));
      }
    } else {
      fs.append(h("p", { class: "hint", text: "まだ問題がありません。「問題を登録」から追加してください。" }));
    }

    const scopeBox = $("scope-box");
    scopeBox.hidden = shared.length === 0;
    setSegmented(scopeBox, "data-scope", settings.scope);

    const notice = $("backup-notice");
    const ownCount = ownVisible().length;
    if (ownCount > 0 && (!settings.lastBackupAt || Date.now() - settings.lastBackupAt >= BACKUP_WARN_DAYS * DAY_MS)) {
      notice.textContent = settings.lastBackupAt
        ? "⚠ 最後のバックアップから " + Math.floor((Date.now() - settings.lastBackupAt) / DAY_MS) + " 日たっています。設定から書き出してください"
        : "⚠ 自作問題がまだ書き出されていません。設定から書き出してください";
      notice.hidden = false;
    } else {
      notice.hidden = true;
    }

    const weak = p.filter((q) => Core.isWeak(records[q.id])).length;
    const unstudied = p.filter((q) => !Core.isStudied(records[q.id])).length;
    const rnd = settings.randomCount > 0 ? Math.min(settings.randomCount, p.length) : p.length;
    setMenuCount("weak", weak);
    setMenuCount("unstudied", unstudied);
    setMenuCount("random", rnd);
  }

  function setMenuCount(kind, n) {
    $("count-" + kind).textContent = n + "問";
    document.querySelector('[data-start="' + kind + '"]').disabled = n === 0;
  }

  // ---- 章・節 ----

  function renderChapters() {
    const p = pool();
    $("start-all").disabled = p.length === 0;
    const box = $("chapter-list");
    clear(box);
    let lastField = null;
    for (const ch of CHAPTERS) {
      if (ch.field !== lastField) {
        const f = FIELDS.find((x) => x.id === ch.field);
        box.append(h("h3", { class: "field-heading", text: f ? f.name : ch.field }));
        lastField = ch.field;
      } else {
        logger.trace("renderChapters: 同じ分野が続く", ch.no);
      }
      const chList = p.filter((q) => sectionMap.get(q.section).chapter.no === ch.no);
      const chSum = Core.summarize(chList, records);
      const details = h("details", { class: "chapter" },
        h("summary", {},
          h("span", { class: "ch-title", text: "第" + ch.no + "章 " + ch.title }),
          h("span", { class: "ch-stat", text: chSum.studied + "/" + chSum.count + " ・ " + Core.formatRate(chSum.rate) })));
      details.append(h("button", {
        type: "button", class: "btn small", disabled: chList.length === 0,
        onclick: () => startQuiz({ kind: "chapter", chapter: ch.no })
      }, "第" + ch.no + "章をまとめて出題（" + chList.length + "問）"));
      const ul = h("ul", { class: "section-list" });
      for (const sec of ch.sections) {
        const list = chList.filter((q) => q.section === sec.code);
        const s = Core.summarize(list, records);
        const policy = sec.subjectB ? SUBJECT_B_POLICY[sec.subjectB] : null;
        ul.append(h("li", {}, h("button", {
          type: "button", class: "section-row" + (list.length === 0 ? " empty" : ""), disabled: list.length === 0,
          onclick: () => startQuiz({ kind: "section", section: sec.code })
        },
        h("span", { class: "sec-main" },
          h("span", { class: "sec-title", text: sec.code + " " + sec.title }),
          sec.key ? h("span", { class: "chip key", text: "★重点" }) : null,
          sec.subjectB ? h("span", { class: "chip subject-b", text: "科目B " + sec.subjectB + (policy ? "（" + policy + "）" : "") }) : null),
        h("span", { class: "sec-stat", text: s.studied + "/" + s.count + " ・ " + Core.formatRate(s.rate) }))));
      }
      details.append(ul);
      box.append(details);
    }
  }

  // ---- 出題 ----

  function newQuestionState() {
    return { revealed: false, judged: null, picked: null, order: null };
  }

  function startQuiz(spec) {
    const p = pool();
    let list;
    let title;
    switch (spec.kind) {
      case "all":
        list = Core.shuffle(p);
        title = "全範囲";
        break;
      case "chapter": {
        const ch = CHAPTERS.find((c) => c.no === spec.chapter);
        list = Core.shuffle(p.filter((q) => sectionMap.get(q.section).chapter.no === spec.chapter));
        title = "第" + spec.chapter + "章 " + (ch ? ch.title : "");
        break;
      }
      case "section":
        list = Core.shuffle(p.filter((q) => q.section === spec.section));
        title = sectionLabel(spec.section);
        break;
      case "weak":
        list = Core.shuffle(p.filter((q) => Core.isWeak(records[q.id])));
        title = "苦手問題";
        break;
      case "unstudied":
        // 登録直後の確認用なので教材順のまま出す
        list = p.filter((q) => !Core.isStudied(records[q.id]));
        title = "未学習の問題";
        break;
      case "random": {
        const n = settings.randomCount > 0 ? settings.randomCount : p.length;
        list = Core.shuffle(p).slice(0, n);
        title = "ランダム";
        break;
      }
      case "ids":
        list = Core.shuffle(spec.ids.map((id) => byId.get(id)).filter(Boolean));
        title = spec.title;
        break;
      default:
        logger.error("startQuiz: 不明な出題方法", spec.kind);
        return;
    }
    if (list.length === 0) {
      showToast("対象の問題がありません");
      return;
    } else {
      logger.info("出題開始", title, list.length);
    }
    quiz = { title, ids: list.map((q) => q.id), index: 0, results: [], state: newQuestionState() };
    show("quiz");
    renderQuestion();
  }

  function currentQuestion() {
    return quiz ? byId.get(quiz.ids[quiz.index]) : undefined;
  }

  function renderQuestion() {
    const q = currentQuestion();
    if (!q) {
      // 出題中に削除された問題などは飛ばす
      logger.info("出題対象が見つからないので次へ", quiz && quiz.ids[quiz.index]);
      nextQuestion();
      return;
    } else {
      logger.trace("renderQuestion", q.id);
    }
    const st = quiz.state;
    $("quiz-title").textContent = quiz.title;
    $("quiz-progress").textContent = (quiz.index + 1) + " / " + quiz.ids.length;
    $("quiz-edit").hidden = q.source !== "own";

    const sec = sectionMap.get(q.section);
    const meta = $("quiz-meta");
    clear(meta);
    meta.append(
      h("span", { class: "chip", text: sectionLabel(q.section) }),
      sec.key ? h("span", { class: "chip key", text: "★" }) : null,
      h("span", { class: "chip", text: Core.TYPE_LABELS[q.type] }),
      h("span", { class: "chip " + (q.source === "shared" ? "shared" : "own"), text: q.source === "shared" ? "共通" : "自作" })
    );
    $("quiz-question").textContent = q.question;

    const body = $("quiz-body");
    const fb = $("quiz-feedback");
    const actions = $("quiz-actions");
    clear(body);
    clear(fb);
    clear(actions);
    fb.hidden = true;
    fb.className = "feedback";

    switch (q.type) {
      case "desc":
        renderDesc(q, st, fb, actions);
        break;
      case "ox":
        renderOx(q, st, body, fb, actions);
        break;
      case "choice":
        renderChoice(q, st, body, fb, actions);
        break;
      default:
        logger.error("renderQuestion: 不明な形式", q.type);
        nextQuestion();
        return;
    }
  }

  function nextLabel() {
    return quiz.index + 1 >= quiz.ids.length ? "結果を見る" : "次へ";
  }

  function fillFeedback(fb, q, correct) {
    if (correct === null) {
      fb.className = "feedback";
    } else {
      fb.className = "feedback " + (correct ? "ok" : "ng");
      fb.append(h("p", { class: "verdict", text: correct ? "○ 正解" : "× 不正解" }));
    }
    fb.append(h("p", { class: "answer" }, h("span", { class: "answer-label", text: "解答" }), h("span", { class: "answer-text", text: answerText(q) })));
    if (q.explanation) {
      fb.append(h("p", { class: "explanation", text: q.explanation }));
    } else {
      logger.trace("fillFeedback: 解説なし");
    }
    fb.hidden = false;
  }

  function renderDesc(q, st, fb, actions) {
    if (!st.revealed) {
      actions.append(h("button", { type: "button", class: "btn primary block", onclick: () => { st.revealed = true; renderQuestion(); } }, "解答を見る"));
    } else if (st.judged === null) {
      fillFeedback(fb, q, null);
      actions.append(
        h("div", { class: "judge-row" },
          h("button", { type: "button", class: "btn ok", onclick: () => judge(true, true) }, "○ 正解"),
          h("button", { type: "button", class: "btn ng", onclick: () => judge(false, true) }, "× 不正解")));
    } else {
      // 編集から戻ったときなど、採点済みなら次へだけ出す
      fillFeedback(fb, q, st.judged);
      actions.append(h("button", { type: "button", class: "btn primary block", onclick: nextQuestion }, nextLabel()));
    }
  }

  function renderOx(q, st, body, fb, actions) {
    const row = h("div", { class: "ox-row" });
    for (const val of [true, false]) {
      const judged = st.judged !== null;
      let cls = "btn ox";
      if (judged && val === q.answer) {
        cls += " correct";
      } else if (judged && val === st.picked) {
        cls += " wrong";
      } else {
        logger.trace("renderOx: 強調なし");
      }
      row.append(h("button", {
        type: "button", class: cls, disabled: judged, "aria-label": val ? "まる" : "ばつ",
        onclick: () => { st.picked = val; judge(val === q.answer, false); }
      }, val ? "〇" : "×"));
    }
    body.append(row);
    if (st.judged !== null) {
      fillFeedback(fb, q, st.judged);
      actions.append(h("button", { type: "button", class: "btn primary block", onclick: nextQuestion }, nextLabel()));
    } else {
      logger.trace("renderOx: 未回答");
    }
  }

  function renderChoice(q, st, body, fb, actions) {
    if (!st.order || st.order.length !== q.choices.length) {
      st.order = Core.shuffle(q.choices.map((_, i) => i));
    } else {
      logger.trace("renderChoice: 並び順は保持");
    }
    const judged = st.judged !== null;
    const list = h("div", { class: "choice-list" });
    st.order.forEach((orig, pos) => {
      let cls = "btn choice";
      if (judged && orig === q.answer) {
        cls += " correct";
      } else if (judged && orig === st.picked) {
        cls += " wrong";
      } else {
        logger.trace("renderChoice: 強調なし");
      }
      list.append(h("button", {
        type: "button", class: cls, disabled: judged,
        onclick: () => { st.picked = orig; judge(orig === q.answer, false); }
      }, h("span", { class: "choice-label", text: Core.CHOICE_LABELS[pos] }), h("span", { class: "choice-text", text: q.choices[orig] })));
    });
    body.append(list);
    if (judged) {
      // 選択肢はシャッフル表示なので、正解の記号は表示した並びで示す
      const pos = st.order.indexOf(q.answer);
      fb.className = "feedback " + (st.judged ? "ok" : "ng");
      fb.append(h("p", { class: "verdict", text: st.judged ? "○ 正解" : "× 不正解" }));
      fb.append(h("p", { class: "answer" }, h("span", { class: "answer-label", text: "解答" }), h("span", { class: "answer-text", text: Core.CHOICE_LABELS[pos] + "　" + q.choices[q.answer] })));
      if (q.explanation) {
        fb.append(h("p", { class: "explanation", text: q.explanation }));
      } else {
        logger.trace("renderChoice: 解説なし");
      }
      fb.hidden = false;
      actions.append(h("button", { type: "button", class: "btn primary block", onclick: nextQuestion }, nextLabel()));
    } else {
      logger.trace("renderChoice: 未回答");
    }
  }

  function judge(correct, advance) {
    const q = currentQuestion();
    if (!q || quiz.state.judged !== null) {
      logger.warn("judge: 二重採点を無視");
      return;
    } else {
      logger.trace("judge", q.id, correct);
    }
    quiz.state.judged = correct;
    quiz.results[quiz.index] = correct;
    records = Core.recordAnswer(records, q.id, correct);
    saveRecords();
    if (advance) {
      nextQuestion();
    } else {
      renderQuestion();
    }
  }

  function nextQuestion() {
    quiz.index++;
    quiz.state = newQuestionState();
    if (quiz.index >= quiz.ids.length) {
      showResult();
    } else {
      renderQuestion();
    }
  }

  function quitQuiz() {
    const answered = quiz ? quiz.results.filter((r) => r !== undefined).length : 0;
    if (answered > 0) {
      showResult();
    } else {
      show("home");
    }
  }

  // ---- 結果 ----

  function showResult() {
    const answeredIdx = [];
    quiz.results.forEach((r, i) => {
      if (r !== undefined) {
        answeredIdx.push(i);
      } else {
        logger.trace("showResult: 未回答", i);
      }
    });
    const correct = answeredIdx.filter((i) => quiz.results[i]).length;
    const wrongIds = answeredIdx.filter((i) => !quiz.results[i]).map((i) => quiz.ids[i]);
    quiz.summary = { answered: answeredIdx.length, correct, wrongIds };

    const rate = answeredIdx.length > 0 ? correct / answeredIdx.length : null;
    $("result-score").textContent = quiz.title + "　" + correct + " / " + answeredIdx.length + " 問正解（" + Core.formatRate(rate) + "）";
    $("result-retry").disabled = quiz.ids.length === 0;
    $("result-wrong").hidden = wrongIds.length === 0;
    $("result-copy").disabled = answeredIdx.length === 0;

    const ul = $("result-wrong-list");
    clear(ul);
    $("result-wrong-title").hidden = wrongIds.length === 0;
    for (const id of wrongIds) {
      const q = byId.get(id);
      if (q) {
        ul.append(h("li", {}, h("div", { class: "q-item static" },
          h("div", { class: "q-badges" }, h("span", { class: "chip", text: sectionLabel(q.section) })),
          h("p", { class: "q-text", text: q.question }),
          h("p", { class: "q-answer", text: "解答：" + answerText(q) }))));
      } else {
        logger.trace("showResult: 削除済みの問題", id);
      }
    }
    show("result");
  }

  async function copyRecordLine() {
    const s = quiz.summary;
    const line = Core.buildRecordLine(new Date(), quiz.title, s.answered, s.correct);
    try {
      await navigator.clipboard.writeText(line);
      showToast("コピーしました。学習記録シートの日付のセルに貼り付けてください");
    } catch (e) {
      logger.warn("クリップボードに書けません", e);
      showToast("コピーできませんでした：" + line.replace(/\t+/g, " / "), true);
    }
  }

  // ---- 登録・編集 ----

  function buildSectionOptions(select) {
    clear(select);
    for (const ch of CHAPTERS) {
      const g = h("optgroup", { label: "第" + ch.no + "章 " + ch.title });
      for (const sec of ch.sections) {
        g.append(h("option", { value: sec.code, text: sec.code + " " + sec.title }));
      }
      select.append(g);
    }
  }

  function currentFormType() {
    const b = $("f-type").querySelector('[aria-checked="true"]');
    return b ? b.getAttribute("data-type") : "desc";
  }

  function setFormType(type) {
    setSegmented($("f-type"), "data-type", type);
    $("f-answer-desc").hidden = type !== "desc";
    $("f-answer-ox").hidden = type !== "ox";
    $("f-answer-choice").hidden = type !== "choice";
  }

  function renderChoiceInputs(choices, correct) {
    const box = $("f-choices");
    clear(box);
    choices.forEach((text, i) => {
      const inputId = "f-choice-" + i;
      box.append(h("div", { class: "choice-input" },
        h("input", { type: "radio", name: "f-correct", value: String(i), checked: i === correct, "aria-label": Core.CHOICE_LABELS[i] + "を正解にする" }),
        h("label", { for: inputId, class: "choice-label", text: Core.CHOICE_LABELS[i] }),
        (function () {
          const input = h("input", { type: "text", id: inputId, class: "choice-text-input", autocomplete: "off" });
          input.value = text;
          return input;
        })(),
        h("button", {
          type: "button", class: "btn small icon", "aria-label": Core.CHOICE_LABELS[i] + "を削除",
          disabled: choices.length <= Core.MIN_CHOICES,
          onclick: () => {
            const cur = readChoiceInputs();
            cur.choices.splice(i, 1);
            const c = cur.correct === i ? -1 : cur.correct > i ? cur.correct - 1 : cur.correct;
            renderChoiceInputs(cur.choices, c);
          }
        }, "×")));
    });
    $("f-add-choice").disabled = choices.length >= Core.MAX_CHOICES;
  }

  function readChoiceInputs() {
    const choices = Array.from($("f-choices").querySelectorAll(".choice-text-input")).map((i) => i.value);
    const checked = $("f-choices").querySelector('input[name="f-correct"]:checked');
    return { choices, correct: checked ? Number(checked.value) : -1 };
  }

  function setOx(value) {
    setSegmented($("f-ox"), "data-ox", value === null ? "" : String(value));
  }

  function readOx() {
    const b = $("f-ox").querySelector('[aria-checked="true"]');
    return b ? b.getAttribute("data-ox") === "true" : null;
  }

  function resetFormFields(type) {
    $("f-question").value = "";
    $("f-answer").value = "";
    $("f-explanation").value = "";
    setOx(null);
    renderChoiceInputs(new Array(DEFAULT_CHOICE_COUNT).fill(""), -1);
    setFormType(type);
    $("edit-error").hidden = true;
  }

  function openEdit(id, returnTo) {
    const q = id ? own.find((x) => x.id === id && !x.deletedAt) : null;
    if (id && !q) {
      showToast("この問題は編集できません（共通問題か削除済み）", true);
      return;
    } else {
      logger.trace("openEdit", id || "新規");
    }
    editing = { id: q ? q.id : null, returnTo: returnTo || "home" };
    buildSectionOptions($("f-section"));
    $("edit-back").textContent = "‹ " + ({ quiz: "問題に戻る", list: "一覧", home: "ホーム" }[editing.returnTo] || "戻る");
    if (q) {
      $("edit-title").textContent = "問題を編集";
      $("edit-save").textContent = "保存する";
      $("edit-delete").hidden = false;
      resetFormFields(q.type);
      $("f-section").value = q.section;
      $("f-question").value = q.question;
      $("f-explanation").value = q.explanation || "";
      switch (q.type) {
        case "desc":
          $("f-answer").value = q.answer;
          break;
        case "ox":
          setOx(q.answer);
          break;
        case "choice":
          renderChoiceInputs(q.choices, q.answer);
          break;
        default:
          logger.warn("openEdit: 不明な形式", q.type);
          break;
      }
    } else {
      $("edit-title").textContent = "問題を登録";
      $("edit-save").textContent = "登録する";
      $("edit-delete").hidden = true;
      resetFormFields(Core.TYPES.includes(settings.lastType) ? settings.lastType : "desc");
      $("f-section").value = sectionMap.has(settings.lastSection) ? settings.lastSection : CHAPTERS[0].sections[0].code;
    }
    show("edit");
  }

  function closeEdit() {
    const back = editing ? editing.returnTo : "home";
    editing = null;
    if (back === "quiz" && quiz) {
      const q = currentQuestion();
      if (q && quiz.state.judged === null) {
        // 形式や選択肢が変わっている可能性があるので、未回答なら出し直す
        quiz.state = newQuestionState();
      } else {
        logger.trace("closeEdit: 採点済みのまま戻る");
      }
      show("quiz");
      renderQuestion();
    } else if (back === "list") {
      show("list");
    } else {
      show("home");
    }
  }

  function submitEdit(e) {
    e.preventDefault();
    const type = currentFormType();
    const raw = {
      id: editing.id || undefined,
      section: $("f-section").value,
      type,
      question: $("f-question").value,
      explanation: $("f-explanation").value
    };
    switch (type) {
      case "desc":
        raw.answer = $("f-answer").value;
        break;
      case "ox":
        raw.answer = readOx();
        break;
      case "choice": {
        const c = readChoiceInputs();
        raw.choices = c.choices;
        raw.answer = c.correct;
        break;
      }
      default:
        logger.error("submitEdit: 不明な形式", type);
        return;
    }
    const prev = editing.id ? own.find((x) => x.id === editing.id) : null;
    if (prev) {
      raw.createdAt = prev.createdAt;
      raw.updatedAt = Date.now();
    } else {
      logger.trace("submitEdit: 新規");
    }
    const r = Core.normalizeQuestion(raw, sectionMap, { allowNewId: true });
    const err = $("edit-error");
    if (!r.ok) {
      err.textContent = "⚠ " + formReason(r.reason, type);
      err.hidden = false;
      return;
    } else {
      err.hidden = true;
    }
    if (prev) {
      own = own.map((x) => (x.id === prev.id ? r.question : x));
    } else {
      own.push(r.question);
    }
    if (!saveOwn()) {
      // 保存に失敗したらメモリ上も元に戻す
      own = prev ? own.map((x) => (x.id === prev.id ? prev : x)) : own.filter((x) => x.id !== r.question.id);
      return;
    } else {
      logger.info(prev ? "問題を更新" : "問題を登録", r.question.id);
    }
    settings.lastSection = r.question.section;
    settings.lastType = r.question.type;
    saveSettings();
    refreshData();
    if (prev) {
      showToast("保存しました");
      closeEdit();
    } else {
      showToast("登録しました（自作 " + ownVisible().length + " 問）");
      resetFormFields(type);
      $("f-question").focus();
    }
  }

  /** 入力画面向けに、検証エラーを操作に沿った言い方へ直す */
  function formReason(reason, type) {
    if (type === "ox" && reason.startsWith("○×")) {
      return "解答の 〇 か × を選んでください";
    } else if (type === "choice" && reason.startsWith("正解の選択肢")) {
      return "正解の選択肢を1つ選んでください";
    } else {
      return reason;
    }
  }

  function deleteEditing() {
    const q = own.find((x) => x.id === editing.id);
    if (!q || !window.confirm("この問題を削除しますか？\n" + q.question.slice(0, 60))) {
      return;
    } else {
      logger.info("問題を削除（論理削除）", q.id);
    }
    // 論理削除：deletedAt を付けて一覧・出題・書き出しから外す
    own = own.map((x) => (x.id === q.id ? Object.assign({}, x, { deletedAt: Date.now() }) : x));
    saveOwn();
    refreshData();
    showToast("削除しました");
    closeEdit();
  }

  // ---- 共通問題の表示 ----

  function openView(id) {
    const q = byId.get(id);
    if (!q) {
      return;
    } else {
      logger.trace("openView", id);
    }
    const body = $("view-body");
    clear(body);
    const rec = records[q.id];
    body.append(
      h("div", { class: "q-badges" },
        h("span", { class: "chip shared", text: "共通" }),
        h("span", { class: "chip", text: sectionLabel(q.section) }),
        h("span", { class: "chip", text: Core.TYPE_LABELS[q.type] })),
      h("p", { class: "quiz-question", text: q.question }),
      q.type === "choice"
        ? h("ol", { class: "view-choices" }, q.choices.map((c, i) => h("li", { class: i === q.answer ? "correct" : "" },
            h("span", { class: "choice-label", text: Core.CHOICE_LABELS[i] }), c)))
        : null,
      h("p", { class: "answer" }, h("span", { class: "answer-label", text: "解答" }), h("span", { class: "answer-text", text: answerText(q) })),
      q.explanation ? h("p", { class: "explanation", text: q.explanation }) : null,
      h("p", { class: "hint", text: "記録：○" + (rec ? rec.correct : 0) + "　×" + (rec ? rec.wrong : 0) }),
      h("p", { class: "hint", text: "共通問題はアプリでは編集できません（PC で questions-shared.js を直します）。" })
    );
    show("view");
  }

  // ---- 一覧 ----

  function buildRangeOptions() {
    const sel = $("list-range");
    if (sel.options.length > 0) {
      return;
    } else {
      logger.trace("buildRangeOptions: 初回");
    }
    sel.append(h("option", { value: "all", text: "すべて" }));
    for (const ch of CHAPTERS) {
      const g = h("optgroup", { label: "第" + ch.no + "章 " + ch.title });
      g.append(h("option", { value: "c:" + ch.no, text: "第" + ch.no + "章 全体" }));
      for (const sec of ch.sections) {
        g.append(h("option", { value: "s:" + sec.code, text: sec.code + " " + sec.title }));
      }
      sel.append(g);
    }
  }

  function filterList() {
    const f = listFilter;
    const words = f.search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return allQuestions.filter((q) => {
      if (f.range.startsWith("c:")) {
        if (sectionMap.get(q.section).chapter.no !== Number(f.range.slice(2))) {
          return false;
        } else {
          logger.trace("filterList: 章一致");
        }
      } else if (f.range.startsWith("s:")) {
        if (q.section !== f.range.slice(2)) {
          return false;
        } else {
          logger.trace("filterList: 節一致");
        }
      } else {
        logger.trace("filterList: 範囲すべて");
      }
      switch (f.kind) {
        case "weak":
          if (!Core.isWeak(records[q.id])) return false;
          break;
        case "own":
          if (q.source !== "own") return false;
          break;
        case "shared":
          if (q.source !== "shared") return false;
          break;
        default:
          logger.trace("filterList: 種類すべて");
          break;
      }
      if (words.length > 0) {
        const hay = [q.question, typeof q.answer === "string" ? q.answer : "", q.explanation || "", (q.choices || []).join(" ")].join(" ").toLowerCase();
        return words.every((w) => hay.includes(w));
      } else {
        return true;
      }
    });
  }

  function renderList() {
    buildRangeOptions();
    $("list-range").value = listFilter.range;
    $("list-kind").value = listFilter.kind;
    $("list-search").value = listFilter.search;
    renderListItems();
  }

  function renderListItems() {
    const items = filterList();
    $("list-count").textContent = items.length + " 問";
    const ul = $("list-items");
    clear(ul);
    const frag = document.createDocumentFragment();
    for (const q of items) {
      const rec = records[q.id];
      frag.append(h("li", {}, h("button", {
        type: "button", class: "q-item",
        onclick: () => (q.source === "own" ? openEdit(q.id, "list") : openView(q.id))
      },
      h("span", { class: "q-badges" },
        h("span", { class: "chip " + q.source, text: q.source === "shared" ? "共通" : "自作" }),
        h("span", { class: "chip", text: q.section }),
        h("span", { class: "chip", text: Core.TYPE_LABELS[q.type] }),
        Core.isWeak(rec) ? h("span", { class: "chip weak", text: "苦手" }) : null,
        rec ? h("span", { class: "rec", text: "○" + rec.correct + " ×" + rec.wrong }) : null),
      h("span", { class: "q-text", text: q.question }))));
    }
    ul.append(frag);
  }

  // ---- 設定・バックアップ ----

  function renderSettings() {
    setSegmented($("set-theme"), "data-theme-value", settings.theme);
    $("set-random").value = String(settings.randomCount);
    const ownCount = ownVisible().length;
    const recCount = Object.keys(records).length;
    $("backup-info").textContent =
      (settings.lastBackupAt ? "最終バックアップ：" + formatDateTime(settings.lastBackupAt) : "まだ書き出していません") +
      "　／　自作問題 " + ownCount + " 問・学習記録 " + recCount + " 問分" +
      (ownInvalidRaw.length > 0 ? "　／　目次にない節の自作問題 " + ownInvalidRaw.length + " 問（保存は残しています）" : "");
    $("app-version").textContent = "アプリ " + APP_VERSION + "　／　共通問題 " + shared.length + " 問　／　保存領域の保護：" + (persisted ? "有効" : "未確認");
  }

  function backupFileName() {
    const d = new Date();
    return "ap-qa-backup-" + Core.formatDate(d, "") + "-" + String(d.getHours()).padStart(2, "0") + String(d.getMinutes()).padStart(2, "0") + ".json";
  }

  async function exportData() {
    const data = Core.buildExport(own, shared.map((q) => q.id), records);
    const text = JSON.stringify(data, null, 1);
    const name = backupFileName();
    const file = new File([text], name, { type: "application/json" });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        // iPhone では共有シートから「"ファイル"に保存」する
        await navigator.share({ files: [file], title: name });
      } else {
        const url = URL.createObjectURL(file);
        const a = h("a", { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
    } catch (e) {
      if (e && e.name === "AbortError") {
        showToast("書き出しをやめました");
      } else {
        logger.error("書き出しに失敗", e);
        showToast("書き出しに失敗しました：" + (e && e.message ? e.message : e), true);
      }
      return;
    }
    settings.lastBackupAt = Date.now();
    saveSettings();
    logger.info("書き出し", data.questions.length);
    showToast("書き出しました（自作 " + data.questions.length + " 問）");
    renderSettings();
  }

  async function importFile(file) {
    let data;
    try {
      data = JSON.parse(await file.text());
    } catch (e) {
      logger.warn("JSON として読めません", e);
      showToast("JSON として読めませんでした：" + file.name, true);
      return;
    }
    const r = Core.parseImport(data, sectionMap);
    if (!r.ok) {
      showToast(r.reason, true);
      return;
    } else {
      logger.info("読み込み", r.kind, r.questions.length);
    }
    const ownIds = new Set(own.map((q) => q.id));
    const updates = r.questions.filter((q) => ownIds.has(q.id)).length;
    const recCount = Object.keys(r.records).length;
    let msg = "次の内容を読み込みます。\n問題 " + r.questions.length + " 問（新規 " + (r.questions.length - updates) + "・上書き " + updates + "）";
    if (r.kind === "backup") {
      msg += "\n学習記録 " + recCount + " 問分（同じ問題の記録は上書き）";
    } else {
      logger.trace("importFile: 配列形式");
    }
    if (r.skipped.length > 0) {
      msg += "\n読み込めない問題 " + r.skipped.length + " 問：\n" + r.skipped.slice(0, 5).map((s) => "・" + (s.index + 1) + "件目 " + s.reason).join("\n");
    } else {
      logger.trace("importFile: スキップなし");
    }
    if (r.questions.length === 0 && recCount === 0) {
      showToast("読み込める問題がありませんでした", true);
      return;
    } else if (!window.confirm(msg)) {
      return;
    } else {
      logger.trace("importFile: 確認 OK");
    }
    const prevOwn = own;
    const prevRecords = records;
    own = Core.applyImport(own, r.questions).own;
    records = Core.mergeRecords(records, r.records);
    if (!saveOwn() || !saveRecords()) {
      own = prevOwn;
      records = prevRecords;
      saveOwn();
      saveRecords();
      return;
    } else {
      refreshData();
    }
    showToast("読み込みました（問題 " + r.questions.length + " 問）");
    renderSettings();
  }

  function resetRecords() {
    if (!window.confirm("学習記録（正解・不正解の回数）をすべて消しますか？\n問題は消えません。")) {
      return;
    } else {
      logger.info("学習記録をリセット");
    }
    // 直前の記録を1世代だけ残す。理由: 誤操作に気づいたときに PC から戻せるようにするため
    saveJson(STORAGE_KEYS.records + "_before_reset", records);
    records = {};
    saveRecords();
    showToast("学習記録をリセットしました");
    renderSettings();
  }

  function deleteAllOwn() {
    const n = ownVisible().length;
    if (n === 0) {
      showToast("自作問題はありません");
      return;
    } else if (!window.confirm("自作問題 " + n + " 問をすべて削除しますか？\n先に書き出しておくことをおすすめします。")) {
      return;
    } else {
      logger.info("自作問題をすべて削除（論理削除）", n);
    }
    const now = Date.now();
    own = own.map((q) => (q.deletedAt ? q : Object.assign({}, q, { deletedAt: now })));
    saveOwn();
    refreshData();
    showToast("自作問題を削除しました");
    renderSettings();
  }

  // ---- イベント ----

  function bindEvents() {
    document.addEventListener("click", (e) => {
      const go = e.target.closest("[data-go]");
      const start = e.target.closest("[data-start]");
      if (go) {
        const to = go.getAttribute("data-go");
        if (to === "edit") {
          openEdit(null, "home");
        } else {
          show(to);
        }
      } else if (start) {
        startQuiz({ kind: start.getAttribute("data-start") });
      } else {
        logger.trace("click: 画面遷移なし");
      }
    });

    $("scope-box").addEventListener("click", (e) => {
      const b = e.target.closest("[data-scope]");
      if (b) {
        settings.scope = b.getAttribute("data-scope");
        saveSettings();
        renderHome();
      } else {
        logger.trace("scope: ボタン外");
      }
    });

    $("start-all").addEventListener("click", () => startQuiz({ kind: "all" }));
    $("quiz-quit").addEventListener("click", quitQuiz);
    $("quiz-edit").addEventListener("click", () => {
      const q = currentQuestion();
      if (q && q.source === "own") {
        openEdit(q.id, "quiz");
      } else {
        logger.trace("quiz-edit: 共通問題は編集不可");
      }
    });

    $("result-retry").addEventListener("click", () => startQuiz({ kind: "ids", ids: quiz.ids, title: quiz.title }));
    $("result-wrong").addEventListener("click", () => startQuiz({ kind: "ids", ids: quiz.summary.wrongIds, title: quiz.title + "（間違えた問題）" }));
    $("result-copy").addEventListener("click", copyRecordLine);

    $("f-type").addEventListener("click", (e) => {
      const b = e.target.closest("[data-type]");
      if (b) {
        setFormType(b.getAttribute("data-type"));
      } else {
        logger.trace("f-type: ボタン外");
      }
    });
    $("f-ox").addEventListener("click", (e) => {
      const b = e.target.closest("[data-ox]");
      if (b) {
        setOx(b.getAttribute("data-ox") === "true");
      } else {
        logger.trace("f-ox: ボタン外");
      }
    });
    $("f-add-choice").addEventListener("click", () => {
      const cur = readChoiceInputs();
      if (cur.choices.length < Core.MAX_CHOICES) {
        cur.choices.push("");
        renderChoiceInputs(cur.choices, cur.correct);
      } else {
        logger.trace("f-add-choice: 上限");
      }
    });
    $("edit-form").addEventListener("submit", submitEdit);
    $("edit-back").addEventListener("click", closeEdit);
    $("edit-delete").addEventListener("click", deleteEditing);

    $("list-range").addEventListener("change", (e) => { listFilter.range = e.target.value; renderListItems(); });
    $("list-kind").addEventListener("change", (e) => { listFilter.kind = e.target.value; renderListItems(); });
    $("list-search").addEventListener("input", (e) => { listFilter.search = e.target.value; renderListItems(); });

    $("set-theme").addEventListener("click", (e) => {
      const b = e.target.closest("[data-theme-value]");
      if (b) {
        settings.theme = b.getAttribute("data-theme-value");
        saveSettings();
        applyTheme();
        renderSettings();
      } else {
        logger.trace("set-theme: ボタン外");
      }
    });
    $("set-random").addEventListener("change", (e) => {
      settings.randomCount = Number(e.target.value);
      saveSettings();
    });
    $("btn-export").addEventListener("click", exportData);
    $("file-import").addEventListener("change", async (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) {
        await importFile(file);
      } else {
        logger.trace("file-import: 未選択");
      }
      e.target.value = "";
    });
    $("btn-reset-records").addEventListener("click", resetRecords);
    $("btn-delete-own").addEventListener("click", deleteAllOwn);
  }

  // ---- 起動 ----

  function registerServiceWorker() {
    if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost")) {
      navigator.serviceWorker.register("sw.js").catch((e) => logger.warn("Service Worker の登録に失敗", e));
    } else {
      logger.info("Service Worker は使わない（file:// などのため）");
    }
  }

  function requestPersist() {
    if (navigator.storage && navigator.storage.persist) {
      navigator.storage.persist()
        .then((granted) => {
          persisted = granted;
        })
        .catch((e) => logger.warn("storage.persist に失敗", e));
    } else {
      logger.trace("storage.persist 非対応");
    }
  }

  loadAll();
  applyTheme();
  bindEvents();
  show("home");
  registerServiceWorker();
  requestPersist();
  logger.info("起動", APP_VERSION, "共通", shared.length, "自作", own.length);
})();
