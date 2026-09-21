// Отчёт о проверке сборки на живом ящике — по стадиям T1…T10.
//
// Отчёт складывается из двух частей:
//   · метрики, которые расширение собирает само (проходы, обогащение,
//     отсев, проверки модели, каталога и TrueConf);
//   · ручные проверки — то, что видит только человек у клиента: тормозит ли
//     клиент, спрашивали ли пароль, есть ли поручения среди отсеянного.
//
// Файл отчёта уходит из организации к разработчикам, поэтому в нём только
// числа, флаги и названия полей: ни адресов, ни тем писем, ни имён серверов,
// ни токенов. Комментарии к ручным проверкам человек пишет сам — страница
// об этом предупреждает.

export const STATUS = {
  pass: "пройдено",
  fail: "не пройдено",
  partial: "частично",
  skip: "не проверялось",
};

export const STAGES = [
  { id: "T1", title: "Проход по ящику", checks: [
    ["t1.resume", "Клиент закрыли посреди прохода — после запуска разбор продолжился, дублей нет"],
    ["t1.perf", "Клиент заметно не тормозит во время прохода"],
    ["t1.memory", "Память клиента во время прохода (МБ — в комментарии)"],
  ] },
  { id: "T2", title: "Обогащение и отсев без модели", checks: [
    ["t2.offline", "Хранение всех сообщений офлайн включено во всех учётных записях"],
    ["t2.run", "Обогащение дошло до конца, клиент не тормозил"],
    ["t2.server", "Долгих чтений почти нет — письма читаются с диска, а не с сервера"],
    ["t2.gate", "Доля отсева без модели — 60–80 %"],
    ["t2.falsepos", "Просмотрены 20 писем, отсеянных как шум: среди них нет поручений (какие причины ошиблись — в комментарии)"],
    ["t2.invites", "Встречи из приглашений видны: «найдено встреч» больше нуля"],
    ["t2.tc", "Ссылки на конференции TrueConf распознаны: «ссылок на конференции» больше нуля"],
    ["t2.me", "Свои адреса полные: алиасы и списки рассылки добавлены в настройках"],
  ] },
  { id: "T3", title: "Классификация моделью", checks: [
    ["t3.connect", "Модель подключена, все ответы проверки — JSON по схеме"],
    ["t3.reasoning", "Модель не рассуждающая"],
    ["t3.sense", "Эталонные письма распознаны верно — не меньше 5 из 6"],
    ["t3.speed", "Время на письмо приемлемо (медиана — в комментарии)"],
  ] },
  { id: "T4", title: "Граф и вкладка «Дела»", checks: [
    ["t4.design", "Макеты вкладки «Дела» получены от дизайнера"],
  ] },
  { id: "T5", title: "Уровень отправителя", checks: [
    ["t5.book", "Адресная книга организации (GAL/AD) видна в Органайзере"],
    ["t5.fields", "Поиск коллеги возвращает должность и подразделение"],
    ["t5.manager", "Поиск возвращает руководителя"],
    ["t5.speed", "Поиск в удалённой книге быстрый, нагрузку на каталог согласовали"],
  ] },
  { id: "T9", title: "TrueConf", checks: [
    ["t9.app", "Администратор создал OAuth-приложение по запросу"],
    ["t9.login", "Вход без второго пароля после входа через плагин TrueConf"],
    ["t9.messages", "Чат конференции читается под обычной учётной записью"],
    ["t9.participants", "Журнал участников конференции читается под обычной учётной записью"],
    ["t9.chatsApi", "Беседы: коннектор принимает токен входа"],
    ["t9.chatsPwd", "Беседы: работают с отдельным токеном по паролю"],
  ] },
  { id: "T10", title: "Релиз", checks: [
    ["t10.install", "Релизная сборка установлена, срок демоверсии показан верно"],
  ] },
];

// --- сбор метрик -----------------------------------------------------------

/** Форматы писем на живом ящике: то, что стенд не воспроизводит. */
export async function formatStats(db) {
  const out = {
    enriched: 0, withReferences: 0, withThreadIndex: 0, onlyThreadIndex: 0,
    calendarByMethod: {}, meetings: 0, tasks: 0, tnef: 0,
    attachments: 0, inlineAttachments: 0, nonInlineImages: 0,
    attachmentsUnknown: 0, conferences: 0, conferencesWithoutHost: 0,
  };
  await db.pages("messages", 2000, (rows) => {
    for (const r of rows) {
      if (r.enriched !== 1) {
        if (r.enriched === 2) out.attachmentsUnknown++;
        continue;
      }
      out.enriched++;
      if (r.thread?.root) out.withReferences++;
      if (r.thread?.index) out.withThreadIndex++;
      if (r.thread?.index && !r.thread?.root) out.onlyThreadIndex++;
      if (r.hasAttachments == null) out.attachmentsUnknown++;
      for (const c of r.calendar ?? []) {
        const m = c.method ?? "без метода";
        out.calendarByMethod[m] = (out.calendarByMethod[m] ?? 0) + 1;
        if (c.kind === "meeting") out.meetings++;
        if (c.kind === "task") out.tasks++;
      }
      for (const a of r.attachments ?? []) {
        out.attachments++;
        if (a.inline) out.inlineAttachments++;
        else if (String(a.contentType).startsWith("image/")) out.nonInlineImages++;
        if (/winmail\.dat$/i.test(a.name) || a.contentType === "application/ms-tnef") out.tnef++;
      }
      for (const c of r.conferences ?? []) {
        out.conferences++;
        if (!c.host) out.conferencesWithoutHost++;
      }
    }
  });
  return out;
}

function scanSummary(checkpoints) {
  return checkpoints.map((c) => ({
    pass: c.scanId,
    done: Boolean(c.done),
    folders: `${c.doneFolders?.length ?? 0} / ${c.folders?.length ?? 0}`,
    stored: c.stats?.stored ?? 0,
    merged: c.stats?.merged ?? 0,
    queries: c.stats?.queries ?? 0,
    errors: c.errors?.length ?? 0,
    // Длительность честна только для прохода без обрывов: после обрыва это
    // время от старта до конца вместе с паузой.
    durationMs: c.finishedAt && c.startedAt ? c.finishedAt - c.startedAt : null,
    // Возобновлён позже, чем через минуту после старта, — был обрыв.
    interrupted: Boolean(c.resumedAt && c.startedAt && c.resumedAt - c.startedAt > 60000),
  }));
}

/**
 * Все автоматические метрики. Зависимости внедряются — страница передаёт
 * настоящие, тесты свои.
 */
export async function collect({ db, cfg, env, gate, me, trueconfSession }) {
  const enrichState = await db.meta.get("enrich");
  return {
    T1: {
      counts: await db.stats(),
      passes: scanSummary(await db.checkpoint.list()),
    },
    T2: {
      // Выборка писем с темами остаётся на экране, в файл не идёт.
      queue: await db.enrichCounts(),
      stats: enrichState?.stats ?? null,
      lastError: enrichState?.error ?? null,
      gate: gate ? { ...gate, samples: undefined } : null,
      formats: await formatStats(db),
      myAddresses: me?.size ?? null,
      aliases: cfg.me.aliases.length,
      settings: {
        freshDelayMinutes: cfg.enrich.freshDelayMinutes,
        maxSizeMb: Math.round(cfg.enrich.maxSizeBytes / 1048576),
        trueconfHostsSet: cfg.trueconf.hosts.length,
      },
    },
    T3: {
      endpointSet: Boolean(cfg.llm.endpoint),
      model: cfg.llm.model || null,
      concurrency: cfg.llm.concurrency,
      check: await db.meta.get("report:model"),
    },
    T5: { check: await db.meta.get("report:directory") },
    T9: {
      serverSet: Boolean(cfg.trueconf.server),
      clientIdSet: Boolean(cfg.trueconf.clientId),
      secretSet: Boolean(cfg.trueconf.clientSecret),
      apiVersion: cfg.trueconf.apiVersion,
      authorizePath: cfg.trueconf.authorizePath,
      session: trueconfSession
        ? { loggedIn: true, scope: trueconfSession.scope ?? null, refresh: trueconfSession.hasRefresh }
        : { loggedIn: false },
      checks: (await db.meta.get("report:trueconf")) ?? {},
      admin: (await db.meta.get("report:trueconf-admin")) ?? {},
    },
    T10: env,
  };
}

// --- оформление ------------------------------------------------------------

const num = (n) => (n == null ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "));
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)} %`);
const yes = (b) => (b ? "да" : "нет");
const cell = (s) => String(s ?? "—").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

function duration(ms) {
  if (ms == null) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин ${s % 60} с` : `${Math.floor(m / 60)} ч ${m % 60} мин`;
}

function when(ms) {
  return ms ? new Date(ms).toLocaleString("ru-RU") : "—";
}

function table(header, rows) {
  if (!rows.length) return "";
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`),
  ].join("\n");
}

/** Ключевая цифра стадии для сводной таблицы. */
function headline(id, a) {
  switch (id) {
    case "T1": {
      const p = Object.fromEntries(a.T1.passes.map((x) => [x.pass, x]));
      return `писем ${num(a.T1.counts.messages)}; свежий проход ${duration(p.recent?.durationMs)}, ` +
        `архив ${duration(p.archive?.durationMs)}`;
    }
    case "T2":
      return `отсев ${pct(a.T2.gate?.removedShare)}; дочитано ${num(a.T2.queue.done)}, ` +
        `в очереди ${num(a.T2.queue.pending)}; долгих чтений ${num(a.T2.stats?.slowReads)}`;
    case "T3": {
      const c = a.T3.check;
      if (!c) return a.T3.endpointSet ? "модель задана, проверка не запускалась" : "модель не подключена";
      if (!c.configured) return c.error;
      return `JSON ${c.validJson}/${c.total}, верно ${c.correct}/${c.total}, ` +
        `медиана ${duration(c.latencyMs?.median)}${c.reasoningDetected ? ", РАССУЖДАЮЩАЯ" : ""}`;
    }
    case "T5": {
      const c = a.T5.check;
      if (!c) return "проверка не запускалась";
      const lf = c.search?.remote?.levelFields;
      return `книг ${c.books} (удалённых ${c.remoteBooks})` + (lf
        ? `; должность ${yes(lf.title)}, подразделение ${yes(lf.department)}, руководитель ${yes(lf.manager)}`
        : "");
    }
    case "T9": {
      const checks = Object.values(a.T9.checks);
      return `вход ${yes(a.T9.session.loggedIn)}; запросов успешно ` +
        `${checks.filter((c) => c.ok).length} из ${checks.length}`;
    }
    case "T10":
      return `версия ${a.T10.version}, ${a.T10.release ? "релиз" : "отладка"}`;
    default:
      return "";
  }
}

function stageDetails(id, a) {
  switch (id) {
    case "T1":
      return table(["Проход", "Завершён", "Папки", "Записано", "Копий", "Запросов", "Ошибок", "Длительность"],
        a.T1.passes.map((p) => [p.pass, yes(p.done), p.folders, num(p.stored), num(p.merged),
          num(p.queries), num(p.errors), duration(p.durationMs) + (p.interrupted ? " (с обрывом)" : "")]));
    case "T2": {
      const s = a.T2.stats ?? {};
      const f = a.T2.formats;
      const g = a.T2.gate;
      const rows = [
        ["Дочитано / в очереди / пропущено / не удалось",
          `${num(a.T2.queue.done)} / ${num(a.T2.queue.pending)} / ${num(a.T2.queue.skipped)} / ${num(a.T2.queue.failed)}`],
        ["Прочитано писем, из них долгих (вероятно, с сервера)", `${num(s.fullReads)}, ${num(s.slowReads)}`],
        ["Запросов к папкам, не найдено писем", `${num(s.queries)}, ${num(s.notFound)}`],
        ["С References / с Thread-Index / только Thread-Index",
          `${num(f.withReferences)} / ${num(f.withThreadIndex)} / ${num(f.onlyThreadIndex)}`],
        ["Части календаря по методу", Object.entries(f.calendarByMethod).map(([k, v]) => `${k}: ${v}`).join(", ") || "нет"],
        ["Встреч / задач из приглашений", `${num(f.meetings)} / ${num(f.tasks)}`],
        ["Вложений winmail.dat (TNEF)", num(f.tnef)],
        ["Вложений / встроенных / картинок не встроенными", `${num(f.attachments)} / ${num(f.inlineAttachments)} / ${num(f.nonInlineImages)}`],
        ["Состав вложений неизвестен", num(f.attachmentsUnknown)],
        ["Ссылок на конференции / без сервера", `${num(f.conferences)} / ${num(f.conferencesWithoutHost)}`],
        ["Своих адресов (в т. ч. из настроек)", `${num(a.T2.myAddresses)} (${num(a.T2.aliases)})`],
        ["Задержка свежих писем, мин; предел размера, МБ",
          `${a.T2.settings.freshDelayMinutes}; ${a.T2.settings.maxSizeMb}`],
        ["Последняя ошибка обогащения", a.T2.lastError ?? "нет"],
      ];
      let out = table(["Показатель", "Значение"], rows);
      if (g) {
        out += "\n\nОтсев без модели:\n\n" + table(["Показатель", "Значение"], [
          ["Всего / мои / ждут заголовков", `${num(g.total)} / ${num(g.own)} / ${num(g.pending)}`],
          ["Шум / информирование / в модель", `${num(g.noise)} / ${num(g.info)} / ${num(g.model)}`],
          ["Отсеяно без модели", pct(g.removedShare)],
        ]);
        const reasons = Object.entries(g.reasons ?? {}).sort((x, y) => y[1] - x[1]);
        if (reasons.length) out += "\n\n" + table(["Причина", "Писем"], reasons.map(([k, v]) => [k, num(v)]));
      }
      return out;
    }
    case "T3": {
      const c = a.T3.check;
      const rows = [
        ["Эндпоинт задан", yes(a.T3.endpointSet)],
        ["Модель", a.T3.model ?? "—"],
        ["Одновременных запросов", a.T3.concurrency],
      ];
      if (c?.configured) {
        rows.push(
          ["Проверка", when(c.at)],
          ["Ответили / JSON / по схеме / верно", `${c.answered} / ${c.validJson} / ${c.schemaOk} / ${c.correct} из ${c.total}`],
          ["Рассуждающая модель", yes(c.reasoningDetected)],
          ["Время ответа мин / медиана / макс", c.latencyMs
            ? `${duration(c.latencyMs.min)} / ${duration(c.latencyMs.median)} / ${duration(c.latencyMs.max)}` : "—"],
          ["Писем в минуту (оценка)", num(c.perMinute)],
          ["Ожидалось → получено", c.confusion.map((x) => `${x.expect}→${x.got ?? "?"}`).join(", ")],
          ["Ошибки", c.errors.join("; ") || "нет"],
        );
      }
      return table(["Показатель", "Значение"], rows);
    }
    case "T5": {
      const c = a.T5.check;
      if (!c) return "";
      const rows = [
        ["Проверка", when(c.at)],
        ["Книг / удалённых / только для чтения", `${c.books} / ${c.remoteBooks} / ${c.readOnlyBooks}`],
        ["Карточек в локальных книгах", num(c.localContacts)],
      ];
      for (const [k, s] of Object.entries(c.search ?? {})) {
        const name = k === "remote" ? "Поиск в удалённых книгах" : "Поиск в локальных книгах";
        rows.push([name, s.error ? `ошибка: ${s.error}`
          : `${num(s.results)} карточек за ${duration(s.ms)}; поля: ${s.fields.join(", ") || "нет"}`]);
      }
      return table(["Показатель", "Значение"], rows);
    }
    case "T9": {
      const t = a.T9;
      const rows = [
        ["Сервер / ID приложения / секрет заданы", `${yes(t.serverSet)} / ${yes(t.clientIdSet)} / ${yes(t.secretSet)}`],
        ["Версия API, страница входа", `${t.apiVersion}, ${t.authorizePath}`],
        ["Вход выполнен", yes(t.session.loggedIn)],
        ["Права токена", t.session.scope ?? "—"],
      ];
      let out = table(["Показатель", "Значение"], rows);
      const checks = Object.entries(t.checks);
      if (checks.length) {
        out += "\n\n" + table(["Запрос", "Итог", "Статус", "Время", "Когда", "Примечание"],
          checks.map(([k, c]) => [k, c.ok ? "успешно" : "ошибка", c.status, duration(c.ms), when(c.at), c.note ?? ""]));
      }
      const admin = Object.entries(t.admin).filter(([, v]) => v);
      if (admin.length) {
        out += "\n\nОтветы администратора TrueConf:\n\n" + table(["Вопрос", "Ответ"], admin);
      }
      return out;
    }
    case "T10":
      return table(["Показатель", "Значение"], [
        ["Версия", a.T10.version],
        ["Сборка", a.T10.release ? `релиз от ${a.T10.buildDate}` : "отладочная"],
        ["Клиент", a.T10.client],
        ["Демоверсия: осталось дней", a.T10.trialDaysLeft ?? "—"],
      ]);
    default:
      return "";
  }
}

/**
 * @param {object} report { generatedAt, auto, manual }
 *   manual: { [checkId]: { status: keyof STATUS, note } }
 */
export function renderMarkdown({ generatedAt, auto, manual = {} }) {
  const lines = [
    `# Отчёт о проверке R7 Triage ${auto.T10.version}`,
    "",
    `Составлен ${when(generatedAt)}. Только числа, флаги и названия полей — без адресов, тем писем, имён серверов и токенов.`,
    "",
    "## Сводка",
    "",
  ];

  const summary = STAGES.map((st) => {
    const counts = { pass: 0, fail: 0, partial: 0, skip: 0 };
    for (const [id] of st.checks) counts[manual[id]?.status ?? "skip"]++;
    return [`${st.id}. ${st.title}`, counts.pass, counts.fail + counts.partial, counts.skip, headline(st.id, auto)];
  });
  lines.push(table(["Стадия", "Пройдено", "Не пройдено или частично", "Не проверялось", "Главное"], summary), "");

  for (const st of STAGES) {
    lines.push(`## ${st.id}. ${st.title}`, "");
    const details = stageDetails(st.id, auto);
    if (details) lines.push(details, "");
    lines.push(table(["Проверка", "Результат", "Комментарий"], st.checks.map(([id, text]) =>
      [text, STATUS[manual[id]?.status ?? "skip"], manual[id]?.note ?? ""])), "");
  }

  lines.push("## Данные для разработчиков", "", "```json",
    JSON.stringify({ generatedAt, auto, manual }, null, 2), "```", "");
  return lines.join("\n");
}
