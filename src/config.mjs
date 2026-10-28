import fs from 'node:fs/promises';
import path from 'node:path';

// TASKBRIDGE_CONFIG_DIR keeps the user's settings out of the program directory:
// an installed build lives in a folder the updater mirrors over, so a config
// written there would be replaced together with the binaries. Without the
// variable the historical layout (config.json beside package.json) is kept, so
// running from a Git checkout behaves exactly as before.
export function configDir(rootDir, env = process.env) {
  const explicit = env.TASKBRIDGE_CONFIG_DIR;
  return explicit && explicit.trim() ? path.resolve(explicit) : path.resolve(rootDir);
}

export async function loadConfig(rootDir, env = process.env) {
  const dir = configDir(rootDir, env);
  const configPath = path.join(dir, 'config.json');
  const examplePath = path.join(rootDir, 'config.example.json');
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const example = await fs.readFile(examplePath, 'utf8');
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, example, 'utf8');
    console.log(`[TaskBridge] config.json created from config.example.json in ${path.dirname(configPath)}`);
    return JSON.parse(example);
  }
}

export async function saveConfig(rootDir, config, env = process.env) {
  const configPath = path.join(configDir(rootDir, env), 'config.json');
  const tmp = `${configPath}.tmp`;
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, configPath);
}
