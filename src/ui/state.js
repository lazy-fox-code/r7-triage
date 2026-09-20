// Страница состояния. Читает IndexedDB напрямую: страницы расширения делят
// origin с фоном, так что гнать десятки мегабайт через runtime.sendMessage
// незачем.

import * as db from "../db.js";

const $ = (id) => document.getElementById(id);
const num = (n) => (n == null ? "—" : String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " "));

function when(ms) {
  return ms ? new Date(ms).toLocaleString("ru-RU") : "—";
}

async function refresh() {
  const counts = await db.stats();
  $("counts").firstElementChild.innerHTML = Object.entries(counts)
    .map(([k, v]) => `<tr><td>${k}</td><td class="v">${num(v)}</td></tr>`)
    .join("");

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
