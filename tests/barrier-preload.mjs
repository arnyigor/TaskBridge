import fs from 'node:fs/promises';
import { existsSync, writeFileSync } from 'node:fs';

// Тестовый предзагрузчик сервера (`node --import <этот файл> src/server.mjs`).
//
// Детерминированный барьер MEDIA-10: публикация архива — это rename, и на нём
// восстановление после 413 останавливается ровно в том окне, где STOP должен
// успеть отменить ход. Тест создаёт armed-файл (барьер взводится), ждёт, пока в
// нём появится «parked» (сервер стоит на барьере), отправляет STOP и отпускает
// барьер, создав release-файл. Никаких sleep-гонок.
const armed = process.env.TB_BARRIER_ARMED;
const release = process.env.TB_BARRIER_RELEASE;

if (armed && release) {
  const realRename = fs.rename;
  let parked = false;
  fs.rename = async (from, to) => {
    if (!parked && String(to).endsWith('.png') && existsSync(armed)) {
      parked = true;
      writeFileSync(armed, 'parked');
      while (!existsSync(release)) await new Promise(resolve => setTimeout(resolve, 10));
    }
    return realRename(from, to);
  };
}
