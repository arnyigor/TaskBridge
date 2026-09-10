import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const vendor = path.resolve('public/vendor');
await mkdir(vendor, { recursive: true });
await Promise.all([
  copyFile(path.resolve('node_modules/marked/lib/marked.esm.js'), path.join(vendor, 'marked.js')),
  copyFile(path.resolve('node_modules/dompurify/dist/purify.es.mjs'), path.join(vendor, 'purify.mjs'))
]);
