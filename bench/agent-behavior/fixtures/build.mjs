// Синтетический каталог для A/B-бенчмарка (§ MR-05).
//
// Дерево строится, а не хранится в git: пустые папки git не умеет, а 5000 файлов
// в репозитории — это не фикстура, а мусор. Всё содержимое детерминировано, поэтому
// прогоны на одной машине и на двух машинах описывают один и тот же каталог.
import fs from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_BULK = 5000;

// [путь, файлы внутри] — порядок не важен, содержимое тоже.
const TREE = [
  ['Learning/UnrealEngine/Unreal Engine For Filmmakers', ['00.Intro.mp4', '01.Installation.mp4', 'Links.txt']],
  ['Learning/UnrealEngine/Unreal Engine For Filmmakers/Chapter 01', ['01.01.Project.mp4', '01.02.UI.mp4', 'chapter.md']],
  ['Learning/UnrealEngine/Unreal Engine For Filmmakers/Chapter 02', ['02.01.Animation.mp4', '02.02.Cameras.mp4', 'chapter.md']],
  // Пустая папка, но с файлом-ссылкой: сценарий «почему она выглядит пустой».
  ['Learning/UnrealEngine/Unreal Engine For Filmmakers/EXR', ['readme.txt']],
  ['Learning/UnrealEngine/Unreal Engine For Filmmakers/Green Screen', ['Links.txt']],
  ['Learning/UnrealEngine/UE5 Automotive Masterclass', ['01.Intro.mp4', '02.Lighting.mp4']],
  ['Learning/UnrealEngine/Other Unreal Course', ['Intro.mp4']],
  ['Learning/Blender/Blender Guru - Donut', ['01.Modeling.mp4', '02.Shading.mp4']],
  ['Learning/Blender/Hard Surface Modeling', ['01.Intro.mp4']],
  ['Learning/Houdini/Houdini Course 01', ['01.Interface.mp4', '02.Vellum.mp4']],
  ['Learning/Houdini/Ocean Course A', ['01.Intro.mp4']],
  ['Learning/Houdini/Ocean Course B', ['01.Intro.mp4']],
  ['Learning/Substance Painter', ['01.Basics.mp4']],
];

const LINKS = 'https://example.invalid/links\n';

/**
 * Создаёт каталог `dir` с деревом Learning. Повторный вызов ничего не ломает:
 * файлы перезаписываются тем же содержимым (прогон не должен зависеть от того,
 * что осталось от предыдущего).
 */
export async function buildFixture(dir, { bulkFiles = DEFAULT_BULK } = {}) {
  await fs.mkdir(dir, { recursive: true });
  for (const [relative, files] of TREE) {
    const target = path.join(dir, relative);
    await fs.mkdir(target, { recursive: true });
    for (const file of files) {
      const body = file === 'Links.txt' ? LINKS : `fixture: ${relative}/${file}\n`;
      await fs.writeFile(path.join(target, file), body);
    }
  }
  const bulk = path.join(dir, 'Learning', '_bulk');
  await fs.mkdir(bulk, { recursive: true });
  // Имена с ведущими нулями: «сколько файлов» считается одной командой, а
  // рекурсивный обход всех 5000 — ровно то, что бенчмарк ищет в лишних вызовах.
  for (let i = 0; i < bulkFiles; i += 1) {
    await fs.writeFile(path.join(bulk, `f-${String(i).padStart(5, '0')}.dat`), '');
  }
  return dir;
}

/** Ожидаемые пути fixture — нужны и генератору, и проверкам в тестах. */
export const FIXTURE_PATHS = TREE.map(([relative]) => relative);
