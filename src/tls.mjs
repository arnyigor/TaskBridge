import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const execFileAsync = promisify(execFile);

function localAddresses() {
  const addresses = new Set(['127.0.0.1']);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (!info.internal && info.family === 'IPv4') addresses.add(info.address);
    }
  }
  return [...addresses];
}

/**
 * Self-signed cert for LAN HTTPS access, cached under dataRoot/tls/.
 * ponytail: SAN list is fixed at first generation — if the machine's LAN IP
 * changes later (new network, DHCP reassignment), delete dataRoot/tls/ to
 * regenerate with the current addresses.
 */
export async function ensureTlsCert(dataRoot) {
  const dir = path.join(dataRoot, 'tls');
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
    return { key, cert, certPath };
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await fs.mkdir(dir, { recursive: true });
  const altNames = ['DNS:localhost', ...localAddresses().map(addr => `IP:${addr}`)].join(',');
  await execFileAsync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-sha256', '-days', '825', '-nodes',
    '-keyout', keyPath, '-out', certPath,
    '-subj', '/CN=TaskBridge',
    '-addext', `subjectAltName=${altNames}`
  ], { windowsHide: true });
  const [key, cert] = await Promise.all([fs.readFile(keyPath), fs.readFile(certPath)]);
  return { key, cert, certPath };
}
