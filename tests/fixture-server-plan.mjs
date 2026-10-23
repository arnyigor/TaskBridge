#!/usr/bin/env node
// The same throwaway TaskBridge as fixture-server.mjs, with Follow Plan switched
// on. It prints {"base","root"} when ready and stays alive until stdin closes —
// the desktop Compose acceptance (DesktopFollowPlanAcceptanceTest) uses it to
// drive the real production composition against a real server.
import readline from 'node:readline';
import { startFixture } from './server-fixture.mjs';

const fixture = await startFixture(undefined, { root: { followPlan: { enabled: true } } });
process.stdout.write(JSON.stringify({ base: fixture.base, root: fixture.root }) + '\n');
const lines = readline.createInterface({ input: process.stdin });
lines.on('close', async () => {
  await fixture.close();
  process.exit(0);
});
