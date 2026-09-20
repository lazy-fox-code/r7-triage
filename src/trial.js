// Срок демоверсии: 90 дней, с 30-го дня — обратный отсчёт при каждом запуске.
//
// Чего эта проверка НЕ делает, и это надо понимать до релиза.
//
// Расширение целиком исполняется на машине пользователя, и весь его код ей
// доступен. Любая локальная проверка срока обходится: переводом часов назад,
// правкой storage.local, переустановкой профиля, удалением этих строк из
// распакованного XPI. Обфускация поднимает цену обхода, но не меняет его
// возможности — см. scripts/build.mjs.
//
// Неснимаемой проверка бывает только серверной: расширение спрашивает
// лицензию у вашего сервиса и без ответа не работает. Это прямо противоречит
// правилу «ничего не уходит наружу» из CLAUDE.md — единственным сетевым
// адресатом заявлен эндпоинт модели, телеметрии нет. Выбор между
// «неснимаемый срок» и «никакой сети» — продуктовый, не технический, и
// сделать его должен заказчик.
//
// Здесь реализован честный вариант: защита от забывчивости, а не от взлома.
// От перевода часов назад стоит водяной знак — наибольшее виденное время;
// назад оно не идёт.
//
// Якорь срока. В отладке 90 дней считаются от установки (installedAt). В
// релизе scripts/build.mjs впекает дату сборки в src/build-info.js, и якорем
// становится она: переустановка профиля срок больше не сбрасывает — свежая
// установка той же сборки берёт ту же дату релиза. Часы назад по-прежнему
// сдерживает водяной знак. Неснимаемой это проверку не делает (см. выше):
// каждая сборка живёт свои 90 дней, дальше нужна новая по каналу обновлений.

import { BUILD_DATE_MS } from "./build-info.js";

const KEY = "trial";
const DAY = 86400000;

export const TRIAL_DAYS = 90;
export const COUNTDOWN_FROM_DAY = 30;

// Водяной знак двигаем не чаще раза в час: панель опрашивает состояние
// каждую секунду, и запись в storage на каждый опрос была бы расточительством
// без всякой пользы — на точность срока этот шаг не влияет.
const WATERMARK_STEP_MS = 3600000;

async function read() {
  const stored = (await browser.storage.local.get(KEY))[KEY] ?? {};
  const now = Date.now();

  const installedAt = stored.installedAt ?? now;
  // Часы могли перевести назад — как случайно, так и намеренно.
  const watermark = Math.max(stored.watermark ?? 0, now);

  const fresh = stored.installedAt !== installedAt;
  const moved = watermark - (stored.watermark ?? 0) >= WATERMARK_STEP_MS;
  if (fresh || moved) {
    await browser.storage.local.set({ [KEY]: { installedAt, watermark } });
  }
  return { installedAt, watermark };
}

/**
 * Состояние срока.
 * @returns {Promise<{installedAt:number, endsAt:number, msLeft:number,
 *                    daysLeft:number, daysUsed:number,
 *                    expired:boolean, countdown:boolean}>}
 */
export async function state() {
  const { installedAt, watermark } = await read();
  // В релизе якорь — впечённая дата сборки; в отладке — установка.
  const anchor = BUILD_DATE_MS || installedAt;
  const endsAt = anchor + TRIAL_DAYS * DAY;
  const msLeft = Math.max(0, endsAt - watermark);

  return {
    installedAt,
    endsAt,
    msLeft,
    daysLeft: Math.ceil(msLeft / DAY),
    daysUsed: Math.floor((watermark - anchor) / DAY),
    expired: msLeft <= 0,
    countdown: (watermark - anchor) / DAY >= COUNTDOWN_FROM_DAY,
  };
}

/** Разбор почты после истечения срока не идёт. Выгрузка данных — идёт. */
export async function allowsScanning() {
  return !(await state()).expired;
}

/** «12 дней 04:31:07» — для обратного секундомера. */
export function formatLeft(msLeft) {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  const days = Math.floor(s / 86400);
  const hh = String(Math.floor((s % 86400) / 3600)).padStart(2, "0");
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  const plural = days % 10 === 1 && days % 100 !== 11 ? "день"
    : [2, 3, 4].includes(days % 10) && ![12, 13, 14].includes(days % 100) ? "дня"
    : "дней";
  return days ? `${days} ${plural} ${hh}:${mm}:${ss}` : `${hh}:${mm}:${ss}`;
}
