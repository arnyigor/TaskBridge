// What other processes are running, for two guards (roadmap R3.5, R3.6):
// a Pi someone started by hand on the same session file, and a Pi left behind by
// a previous TaskBridge. Windows needs WMI for command lines, which takes about
// a second, so the list is cached briefly and every query has a hard timeout.
// A failed query is "unknown", never "nobody": callers decide how to treat it.

import { execFile } from 'node:child_process';

const CACHE_MS = 5000;
const TIMEOUT_MS = 8000;
let cached = null;

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error); else resolve(stdout);
    });
  });
}

// WMI dates look like 20260925183411.123456+180 (local time + offset in minutes).
export function parseWmiDate(value) {
  const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{3})\d*([+-])(\d{3})$/.exec(String(value || ''));
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms, sign, offset] = match;
  const utc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, +ms);
  return utc - (sign === '+' ? 1 : -1) * Number(offset) * 60000;
}

async function query() {
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | ForEach-Object { "{0}`t{1}`t{2}" -f $_.ProcessId, $_.CreationDate.ToString("yyyyMMddHHmmss.fff000zzz").Replace(":", ""), $_.CommandLine }';
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
    return out.split(/\r?\n/).filter(Boolean).map(line => {
      const [pid, created, ...rest] = line.split('\t');
      return { pid: Number(pid), startedAt: parsePsOffsetDate(created), commandLine: rest.join('\t') };
    }).filter(item => Number.isInteger(item.pid));
  }
  const out = await run('ps', ['-eo', 'pid=,lstart=,args=']);
  return out.split('\n').filter(Boolean).map(line => {
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d+\s+[\d:]+\s+\d{4})\s+(.*)$/.exec(line);
    return match ? { pid: Number(match[1]), startedAt: Date.parse(match[2]) || null, commandLine: match[3] } : null;
  }).filter(Boolean);
}

// PowerShell's zzz gives "+03:00"; with ":" removed it is "+0300".
function parsePsOffsetDate(value) {
  const match = /^(\d{14})\.(\d{3})\d*([+-])(\d{2})(\d{2})$/.exec(String(value || ''));
  if (!match) return parseWmiDate(value);
  const [, stamp, ms, sign, hh, mm] = match;
  return parseWmiDate(`${stamp}.${ms}000${sign}${String(Number(hh) * 60 + Number(mm)).padStart(3, '0')}`);
}

/** [{pid, startedAt (ms epoch or null), commandLine}], or null when the OS would not say. */
export async function listProcesses({ fresh = false } = {}) {
  if (!fresh && cached && Date.now() - cached.at < CACHE_MS) return cached.list;
  const list = await query().catch(() => null);
  cached = { at: Date.now(), list };
  return list;
}

const normalizePath = value => String(value || '').replace(/\\/g, '/').toLowerCase();

/** Processes whose command line names `file`, except the pids in `exclude`. null = unknown. */
export async function processesUsingFile(file, { exclude = new Set(), list } = {}) {
  const processes = list || await listProcesses();
  if (!processes) return null;
  const needle = normalizePath(file);
  return processes.filter(item => !exclude.has(item.pid) && item.pid !== process.pid && normalizePath(item.commandLine).includes(needle));
}

/**
 * The process with this pid, if it is still the one we started: a pid is reused
 * by the OS, so it must also have been created within `toleranceMs` of the
 * moment we recorded. null = gone or a different process.
 */
export async function sameProcess(pid, startedAt, { toleranceMs = 15000, list } = {}) {
  const processes = list || await listProcesses({ fresh: true });
  const found = processes?.find(item => item.pid === pid);
  if (!found || !found.startedAt || !startedAt) return null;
  return Math.abs(found.startedAt - Date.parse(startedAt)) <= toleranceMs ? found : null;
}
