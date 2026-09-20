// Обратный секундомер демоверсии. Показывается при запуске клиента начиная
// с 30-го дня и тикает, пока окно открыто.

import { state, formatLeft, TRIAL_DAYS } from "../trial.js";

const $ = (id) => document.getElementById(id);

const s = await state();

$("ends").textContent = s.expired
  ? `Срок истёк ${new Date(s.endsAt).toLocaleDateString("ru-RU")}`
  : `Срок заканчивается ${new Date(s.endsAt).toLocaleString("ru-RU")}`;

$("note").textContent = s.expired
  ? "Разбор почты остановлен. Выгрузка накопленного состояния в JSON "
    + "продолжает работать — данные остаются вашими."
  : `Демоверсия рассчитана на ${TRIAL_DAYS} дней. Почта и результаты разбора `
    + "никуда не передаются: расширение работает целиком на этой машине.";

if (s.expired) {
  $("sub").textContent = "Срок работы демоверсии истёк";
  $("left").classList.add("over");
}

// Секундомер идёт от времени открытия окна: пересчитывать состояние каждую
// секунду незачем, а часы в этот момент уже проверены водяным знаком.
const shownAt = Date.now();

function tick() {
  const left = s.msLeft - (Date.now() - shownAt);
  $("left").textContent = left > 0 ? formatLeft(left) : "00:00:00";
}

tick();
setInterval(tick, 1000);

$("ok").addEventListener("click", () => window.close());
