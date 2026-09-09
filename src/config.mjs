import fs from 'node:fs/promises';
import path from 'node:path';

export async function loadConfig(rootDir) {
  const configPath = path.join(rootDir, 'config.json');
  const examplePath = path.join(rootDir, 'config.example.json');
  try {
    const text = await fs.readFile(configPath, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const example = await fs.readFile(examplePath, 'utf8');
    await fs.writeFile(configPath, example, 'utf8');
    console.log('[TaskBridge] config.json created from config.example.json');
    return JSON.parse(example);
  }
}

export async function saveConfig(rootDir, config) {
  const configPath = path.join(rootDir, 'config.json');
  const tmp = `${configPath}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, configPath);
}
