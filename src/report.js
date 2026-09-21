// Замер гейта — главный вопрос T2: какую долю писем дешёвые признаки
// снимают до модели. Цель 60-80 %. Меньше — чинить признаки, а не
// наращивать мощность инференса.
//
// Считается по всей базе на лету: гейт выводится при чтении, так что после
// правки правил или своих адресов замер сразу показывает новую картину, без
// повторного прохода. Разбивка по причинам нужна, чтобы увидеть правило,
// которое на живом ящике срабатывает слишком широко.

import { derive, gate } from "./features.js";

/**
 * @param {object} deps.db   модуль хранилища
 * @param {Set<string>} deps.me свои адреса
 * @param {object} deps.cfg  ветка `gate` из настроек
 */
export async function gateReport({ db, me, cfg, batch = 2000, onProgress = () => {} }) {
  const out = {
    at: Date.now(),
    total: 0, own: 0, pending: 0, model: 0, noise: 0, info: 0,
    reasons: {},
  };

  await db.pages("messages", batch, (rows) => {
    for (const row of rows) {
      const g = gate(derive(row, me), cfg);
      out.total++;
      out[g.outcome]++;
      if (g.label) {
        const k = `${g.label}: ${g.reason}`;
        out.reasons[k] = (out.reasons[k] ?? 0) + 1;
      }
    }
    onProgress(out.total);
  });

  // Доля считается от писем, по которым гейт мог решать: свои письма не
  // классифицируются, а недочитанные ещё ждут полных заголовков.
  const base = out.noise + out.info + out.model;
  out.decidable = base;
  out.removedShare = base ? (out.noise + out.info) / base : null;
  return out;
}
