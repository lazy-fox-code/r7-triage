// Страница состояния. Читает IndexedDB напрямую: страницы расширения делят
// origin с фоном, так что гнать десятки мегабайт через runtime.sendMessage
// незачем.

import * as db from "../db.js";
import * as settings from "../settings.js";

const $ = (id) => document.getElementById(id);
const num = (n) => (n == null ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "));

function when(ms) {
  return ms ? new Date(ms).toLocaleString("ru-RU") : "—";
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const pct = (x) => (x == null ? "—" : `${Math.round(x * 100)} %`);

function renderEnrich(counts, st) {
  const s = st?.stats ?? {};
  $("enrich").innerHTML = `
    дочитано ${num(counts.done)}, в очереди ${num(counts.pending)},
    пропущено по размеру ${num(counts.skipped)}, не удалось ${num(counts.failed)}<br>
    прочитано писем ${num(s.fullReads)}, из них долгих (похоже, скачаны с
    сервера) ${num(s.slowReads)}, запросов к папкам ${num(s.queries)},
    не найдено ${num(s.notFound)}<br>
    найдено встреч ${num(s.meetings)}, задач ${num(s.tasks)},
    ссылок на конференции ${num(s.conferences)}<br>
    ${st?.finishedAt ? `очередь пуста с ${when(st.finishedAt)}` : ""}
    ${st?.error ? `<br><span class="danger">${esc(st.error)}</span>` : ""}`;
}

/** Выборка отсеянных писем. Только на экране — в отчёт о проверке не идёт. */
function sampleTable(title, rows) {
  if (!rows?.length) return "";
  const body = rows.slice().sort((a, b) => b.date - a.date).map((x) => `<tr>
    <td>${esc(new Date(x.date).toLocaleDateString("ru-RU"))}</td><td>${esc(x.from)}</td>
    <td>${esc(x.subject)}</td><td>${esc(x.reason)}</td></tr>`).join("");
  return `<p>${esc(title)} (${rows.length}). Если среди них есть поручение — отметьте
    причину в отчёте о проверке: это правило отсева надо чинить.</p>
    <table><tr><th>Дата</th><th>От кого</th><th>Тема</th><th>Причина</th></tr>${body}</table>`;
}

/**
 * Частые адресаты входящей почты — кандидаты в «свои адреса». Списки
 * рассылки отдела приходят не на личный адрес, и пока их нет в настройках,
 * «мне в Кому» и «я в копии» считаются неверно, а с ними — весь отсев.
 */
function recipientsBlock(rows, mine) {
  if (!rows?.length) return "";
  const body = rows.map((x) => `<tr><td>${esc(x.email)}</td><td class="v">${num(x.letters)}</td>
    <td>${x.neverWrites ? "только получает — похоже на список рассылки" : "пишет сам"}</td>
    <td><button data-alias="${esc(x.email)}">это мой адрес</button></td></tr>`).join("");
  const candidates = rows.filter((x) => x.neverWrites).map((x) => x.email);
  const all = candidates.length > 1
    ? `<p><button data-alias-all="${esc(candidates.join(","))}">Добавить все адреса, которые только получают
       (${candidates.length})</button></p>`
    : "";
  return `<p>Кому адресована приходящая почта (${num(mine)} своих адресов в расчёте).
    Адрес, который только получает письма и никогда не пишет, — это список рассылки или
    общий ящик. Пока такие адреса не в «своих», письма на них считаются не адресованными
    вам, и половина правил отсева работает неверно.</p>
    <table><tr><th>Адрес</th><th>Писем</th><th></th><th></th></tr>${body}</table>${all}`;
}

/**
 * Кто закрывает вопросы за вас: отвечал в ветках, где обращались к вам, а вы
 * промолчали. Это сотрудники отдела и заместители — по адресу и по адресной
 * книге их не видно, а по почте видно.
 */
function teamBlock(rows) {
  if (!rows?.length) return "";
  const body = rows.map((x) => `<tr><td>${esc(x.name || x.email)}</td><td>${esc(x.email)}</td>
    <td class="v">${num(x.answers)}</td>
    <td>${x.known ? "в вашей команде" : `<button data-team="${esc(x.email)}">это мой сотрудник</button>`}</td></tr>`).join("");
  return `<p>Кто отвечает за вас. Столбец «ответов» — в скольких обращённых к вам
    переписках человек ответил вместо вас. Отмеченные считаются вашими сотрудниками:
    письмо, на которое такой человек ответил, для вас информирование.</p>
    <table><tr><th>Кто</th><th>Адрес</th><th>Ответов</th><th></th></tr>${body}</table>`;
}

function renderGate(r) {
  if (!r) { $("gateOut").textContent = "Ещё не считали."; return; }
  const rows = [
    ["писем всего", num(r.total)],
    ["мои письма (не классифицируются)", num(r.own)],
    ["ждут полных заголовков", num(r.pending)],
    ["шум без модели", num(r.noise)],
    ["информирование без модели", num(r.info)],
    ["в модель", num(r.model)],
    ["<b>отсеяно без модели</b>", `<b>${pct(r.removedShare)}</b>`],
    ["своих адресов в расчёте", num(r.myAddresses)],
  ];
  const reasons = Object.entries(r.reasons ?? {}).sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v">${num(v)}</td></tr>`).join("");
  const left = Object.entries(r.modelReasons ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td class="v">${num(v)}</td></tr>`).join("");
  const senders = r.senders ? `<p>Отправители:</p><table>
    <tr><td>всего адресов</td><td class="v">${num(r.senders.total)}</td></tr>
    <tr><td>информационных систем</td><td class="v">${num(r.senders.system)}</td></tr>
    <tr><td>вещание на многих</td><td class="v">${num(r.senders.broadcast)}</td></tr>
    <tr><td>обычных отправителей</td><td class="v">${num(r.senders.person)}</td></tr>
    <tr><td>своих писем, из них вне папки «Отправленные»</td>
      <td class="v">${num(r.senders.mine)} / ${num(r.senders.mineOutsideSent)}</td></tr></table>` : "";
  $("gateOut").innerHTML = `
    <table>${rows.map(([k, v]) => `<tr><td>${k}</td><td class="v">${v}</td></tr>`).join("")}</table>
    ${reasons ? `<p>По причинам:</p><table>${reasons}</table>` : ""}
    ${left ? `<p>Осталось модели — чем письма попали в очередь:</p><table>${left}</table>` : ""}
    ${senders}
    ${recipientsBlock(r.topRecipients, r.myAddresses)}
    ${teamBlock(r.team)}
    ${sampleTable("Для проверки глазами: случайные письма, отсеянные как шум", r.samples?.noise)}
    ${sampleTable("…и как информирование", r.samples?.info)}
    <p>Посчитано ${when(r.at)}. Доля — от писем, по которым отсев мог решать:
    без своих и недочитанных.</p>`;
}

for (const [id, cmd, note] of [["tagsRun", "tags.run", "Расставляю метки…"],
  ["tagsClear", "tags.clear", "Снимаю метки…"], ["tagsStop", "tags.stop", "Останавливаю…"]]) {
  document.getElementById(id).addEventListener("click", async () => {
    $("tagsOut").textContent = note;
    try {
      await browser.runtime.sendMessage({ cmd });
    } catch (e) {
      $("tagsOut").textContent = String(e?.message ?? e);
      return;
    }
    renderTags(await db.meta.get("tagger"));
  });
}

// Кнопка «это мой адрес» рядом с частым адресатом: дописывает его в свои
// адреса. После этого замер отсева стоит посчитать заново.
document.addEventListener("click", async (e) => {
  const one = e.target?.dataset?.alias;
  const many = e.target?.dataset?.aliasAll;
  const mate = e.target?.dataset?.team;
  const undo = e.target?.dataset?.undo;
  if (undo) {
    e.target.disabled = true;
    e.target.textContent = "возвращаю…";
    try {
      const res = await browser.runtime.sendMessage({ cmd: "archive.undo", at: Number(undo) });
      e.target.textContent = `возвращено писем: ${res?.moved ?? 0}`;
      renderArchive(await db.meta.get("archive:receipts"));
  renderTags(await db.meta.get("tagger"));
    } catch (err) {
      e.target.textContent = `не вышло: ${String(err?.message ?? err)}`;
    }
    return;
  }
  if (!one && !many && !mate) return;
  const cfg = await settings.load();
  if (mate) {
    await settings.save("me", { team: [...new Set([...cfg.me.team, mate])] });
  } else {
    const add = one ? [one] : many.split(",").filter(Boolean);
    await settings.save("me", { aliases: [...new Set([...cfg.me.aliases, ...add])] });
  }
  e.target.textContent = "добавлено — пересчитайте отсев";
  e.target.disabled = true;
});

/** Расписки о переносе в архив: что, когда, куда — и кнопка «вернуть». */
function renderArchive(receipts) {
  const box = $("archive");
  if (!receipts?.length) { box.textContent = "Ничего не переносили."; return; }
  box.innerHTML = receipts.slice(0, 20).map((r) => `<p>
    ${esc(when(r.at))} — ${num(r.letters?.length ?? 0)} писем в папку
    ${esc(r.target?.path ?? "—")}${r.missing ? `, не найдено ${num(r.missing)}` : ""}.
    <button data-undo="${r.at}">вернуть на место</button></p>`).join("");
}

/** Состояние прохода меток. */
function renderTags(st) {
  const box = $("tagsOut");
  if (!st) { box.textContent = "Метки не расставлялись."; return; }
  const what = st.clear ? "снято меток" : "помечено писем";
  const n = st.clear ? st.cleared : st.tagged;
  box.innerHTML = `${what}: <b>${num(n)}</b>, просмотрено ${num(st.seen)},
    папок пройдено ${num(st.doneFolders?.length ?? 0)}
    ${st.done ? `— закончено ${esc(when(st.finishedAt))}` : "— не закончено"}`;
}

async function refresh() {
  const counts = await db.stats();
  $("counts").firstElementChild.innerHTML = Object.entries(counts)
    .map(([k, v]) => `<tr><td>${k}</td><td class="v">${num(v)}</td></tr>`)
    .join("");

  renderEnrich(await db.enrichCounts(), await db.meta.get("enrich"));
  renderGate(await db.meta.get("gate:report"));
  renderArchive(await db.meta.get("archive:receipts"));

  const scans = await db.checkpoint.list();
  $("scans").innerHTML = scans.length
    ? scans.map((s) => `
        <p><b>${s.scanId}</b> — ${s.done ? "завершён" : "не завершён"}<br>
        папок ${s.doneFolders?.length ?? 0} из ${s.folders?.length ?? 0},
        писем записано ${num(s.stats?.stored)},
        запросов ${num(s.stats?.queries)}<br>
        начат ${when(s.startedAt)}, чекпойнт ${when(s.savedAt)}
        ${s.errors?.length ? `<br><span class="danger">ошибок: ${s.errors.length}</span>` : ""}
        </p>`).join("")
    : "Проходов не было.";
}

$("gate").addEventListener("click", async () => {
  const btn = $("gate");
  btn.disabled = true;
  $("gateOut").textContent = "Считаю…";
  try {
    renderGate(await browser.runtime.sendMessage({ cmd: "gate.report" }));
  } catch (e) {
    $("gateOut").textContent = `Не получилось: ${e?.message ?? e}`;
  } finally {
    btn.disabled = false;
  }
});

$("build").addEventListener("click", async () => {
  const btn = $("build");
  btn.disabled = true;
  $("status").textContent = "Собираю…";
  try {
    const parts = [];
    let bytes = 0;
    await db.exportChunks((chunk) => {
      parts.push(chunk);
      bytes += chunk.length;
      $("status").textContent = `Собрано ${(bytes / 1048576).toFixed(1)} МБ…`;
    });

    const blob = new Blob(parts, { type: "application/json" });
    const link = $("link");
    if (link.href) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(blob);
    link.hidden = false;
    $("status").textContent = `Готово: ${(blob.size / 1048576).toFixed(1)} МБ.`;
  } catch (e) {
    $("status").textContent = `Не получилось: ${e?.message ?? e}`;
  } finally {
    btn.disabled = false;
  }
});

$("reset").addEventListener("click", async () => {
  if (!confirm("Удалить всё разобранное вместе с чекпойнтами?")) return;
  $("status").textContent = "Удаляю…";
  try {
    // Через фон: он держит собственное соединение и должен закрыть его сам,
    // иначе удаление базы будет заблокировано.
    await browser.runtime.sendMessage({ cmd: "db.reset" });
    await db.reset();
    $("status").textContent = "База удалена.";
    await refresh();
  } catch (e) {
    $("status").textContent = `Не получилось: ${e?.message ?? e}`;
  }
});

refresh();
