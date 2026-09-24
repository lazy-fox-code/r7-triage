// Замер гейта — главный вопрос T2: какую долю писем дешёвые признаки
// снимают до модели. Цель 60-80 %. Меньше — чинить признаки, а не
// наращивать мощность инференса.
//
// Считается по всей базе на лету: гейт выводится при чтении, так что после
// правки правил или своих адресов замер сразу показывает новую картину, без
// повторного прохода. Разбивка по причинам нужна, чтобы увидеть правило,
// которое на живом ящике срабатывает слишком широко.
//
// Перед замером обновляются профили отправителей: половина правил решает по
// тому, кто пишет и отвечали ли вы ему, а это считается по всему ящику
// (`senders.js`). Профили остаются в `people` — их же берёт вкладка «Дела».

import { derive, gate, modelSignature } from "./features.js";
import { profileSenders } from "./senders.js";
import { DEFAULTS } from "./settings.js";

/**
 * @param {object} deps.db   модуль хранилища
 * @param {Set<string>} deps.me свои адреса
 * @param {object} deps.cfg  ветка `gate` из настроек
 * @param {number} deps.sampleSize сколько случайных отсеянных писем каждого
 *   класса отложить для просмотра глазами. Выборка показывается только на
 *   странице состояния и в отчёт о проверке не попадает: в ней темы писем.
 */
export async function gateReport({
  db, me, cfg, sendersCfg = DEFAULTS.senders, senders = null,
  batch = 2000, sampleSize = 0, onProgress = () => {},
}) {
  const profiled = senders
    ? { profiles: senders, counts: null }
    : await profileSenders({ db, me, cfg: sendersCfg, batch, onProgress });
  const out = {
    at: Date.now(),
    total: 0, own: 0, pending: 0, model: 0, noise: 0, info: 0,
    reasons: {},
    // Чем оставшиеся письма попали в очередь к модели: по этой гистограмме
    // видно, какое правило снимет следующую тысячу, а какое ничего не даст.
    modelReasons: {},
    senders: profiled.counts,
    aliasCandidates: profiled.counts?.aliasCandidates ?? 0,
    // Кто закрывает вопросы за вас — только на экран, в файл отчёта уходит
    // одно число.
    team: profiled.team ?? [],
    // Кандидаты в «свои адреса»: списки рассылки, на которые приходит почта.
    // Только на экран — в отчёт о проверке адреса не идут.
    topRecipients: profiled.topRecipients ?? [],
  };
  // Равномерная случайная выборка по всему ящику (reservoir sampling):
  // первые письма ящика не должны вытеснять остальные.
  const samples = { noise: [], info: [] };
  const seen = { noise: 0, info: 0 };

  await db.pages("messages", batch, (rows) => {
    for (const row of rows) {
      const f = derive(row, me, {
        senders: profiled.profiles, threads: profiled.threads, teamThreads: profiled.teamThreads,
      });
      const g = gate(f, cfg);
      out.total++;
      out[g.outcome]++;
      if (g.outcome === "model") {
        const sig = modelSignature(f);
        out.modelReasons[sig] = (out.modelReasons[sig] ?? 0) + 1;
      }
      if (g.label) {
        const k = `${g.label}: ${g.reason}`;
        out.reasons[k] = (out.reasons[k] ?? 0) + 1;
        if (sampleSize && samples[g.label]) {
          const n = ++seen[g.label];
          const item = { date: row.date, from: row.fromId, subject: row.subject, reason: g.reason, quote: g.quote };
          if (samples[g.label].length < sampleSize) samples[g.label].push(item);
          else {
            const j = Math.floor(Math.random() * n);
            if (j < sampleSize) samples[g.label][j] = item;
          }
        }
      }
    }
    onProgress(out.total);
  });

  // Доля считается от писем, по которым гейт мог решать: свои письма не
  // классифицируются, а недочитанные ещё ждут полных заголовков.
  const base = out.noise + out.info + out.model;
  out.decidable = base;
  out.removedShare = base ? (out.noise + out.info) / base : null;
  if (sampleSize) out.samples = samples;
  return out;
}
