import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  DEFAULT_KEEP_IMAGES,
  DEFAULT_SESSION_MAX_MB,
  DEFAULT_ARTIFACT_LABEL,
  shrinkSession,
  shrinkSessionFile
} from '../src/session-shrink.mjs';

// Usage (dry run by default — nothing is written):
//   node scripts/session-shrink.mjs <session.jsonl> [--keep-images 2] [--limit-mb 24]
//                                   [--artifacts data/media] [--write]
// --write keeps a copy next to the original (<session>.bak-<timestamp>) and moves
// the originals of the removed screenshots into the artifact directory.
// Why a session needs this, and what exactly is moved where: src/session-shrink.mjs.
// TaskBridge runs the same repair itself (Session preflight) before it starts Pi
// on a session, and again when a provider answers 413 — this CLI is for machines
// where the server is not running.

function parseArgs(argv) {
  const args = {
    file: null,
    keepImages: DEFAULT_KEEP_IMAGES,
    limitMb: DEFAULT_SESSION_MAX_MB,
    artifacts: DEFAULT_ARTIFACT_LABEL,
    write: false
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--write') args.write = true;
    else if (arg === '--keep-images') args.keepImages = Number(argv[++i]);
    else if (arg === '--limit-mb') args.limitMb = Number(argv[++i]);
    else if (arg === '--artifacts') args.artifacts = argv[++i];
    else if (!args.file) args.file = arg;
  }
  return args;
}

const MB = bytes => Number((bytes / 1048576).toFixed(1));

async function main() {
  const { file, keepImages, limitMb, artifacts, write } = parseArgs(process.argv.slice(2));
  if (!file) {
    console.error('usage: node scripts/session-shrink.mjs <session.jsonl> [--keep-images N] [--limit-mb N] [--artifacts DIR] [--write]');
    process.exit(2);
  }
  if (!Number.isInteger(keepImages) || keepImages < 0) {
    console.error('--keep-images expects a non-negative integer');
    process.exit(2);
  }
  if (!(limitMb > 0)) {
    console.error('--limit-mb expects a positive number');
    process.exit(2);
  }
  const limitBytes = Math.round(limitMb * 1048576);

  if (write) {
    const artifactDir = path.resolve(artifacts);
    const result = await shrinkSessionFile(file, {
      keepImages,
      limitBytes,
      artifactDir,
      artifactLabel: artifacts
    });
    console.log(JSON.stringify({
      file,
      written: result.changed,
      reason: result.reason,
      beforeMb: result.beforeBytes != null ? MB(result.beforeBytes) : null,
      afterMb: result.afterBytes != null ? MB(result.afterBytes) : null,
      images: result.images ?? null,
      dropped: result.dropped ?? 0,
      kept: result.kept ?? 0,
      artifacts: result.artifacts ?? 0,
      artifactsNew: result.written ?? 0,
      artifactDir,
      backup: result.backup ?? null
    }, null, 2));
    return;
  }

  const before = await fs.readFile(file, 'utf8');
  const result = shrinkSession(before, { keepImages });
  const beforeBytes = Buffer.byteLength(before, 'utf8');
  const afterBytes = Buffer.byteLength(result.text, 'utf8');
  console.log(JSON.stringify({
    file,
    overLimit: beforeBytes > limitBytes,
    limitMb,
    images: result.images,
    kept: result.kept,
    dropped: result.dropped,
    droppedMb: MB(result.droppedBytes),
    beforeMb: MB(beforeBytes),
    afterMb: MB(afterBytes),
    unparsedLines: result.unparsed,
    written: false
  }, null, 2));
  console.log('dry run: pass --write to rewrite the session (a .bak-<timestamp> copy and the original images are kept)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
