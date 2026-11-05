import crypto from 'node:crypto';
import { externalError as fail } from './windows-reader.mjs';
import { externalProjectIdentity } from './config.mjs';

export const externalActor = (access, req) => access.local(req) ? 'local' : access.device(req)?.deviceId || null;

export function createExternalRoutes({ service, manager, access, json, readJson }) {
  const tokens = new Map();
  return {
    issue(taskId) {
      const token = crypto.randomBytes(32).toString('hex');
      const task = manager.getTask(taskId);
      tokens.set(taskId, { token, registrationKey: externalProjectIdentity(manager.projects.get(task?.projectId)) });
      return { token, revoke: () => { if (tokens.get(taskId)?.token === token) tokens.delete(taskId); } };
    },
    async internal(req, res, url) {
      const match = url.pathname.match(/^\/api\/internal\/external-files\/([^/]+)\/(roots|list|open)$/);
      if (!match) return false;
      res.setHeader('cache-control', 'no-store');
      const [, taskId, operation] = match;
      const supplied = String(req.headers['x-taskbridge-external-token'] || '');
      const capability = tokens.get(taskId);
      const token = capability?.token;
      if (!access.local(req) || !token || !/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== token.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(token)) || !manager.runtimes.get(taskId)?.pi || manager.runtimes.get(taskId).pi.closed) throw fail();
      const project = service.taskProject(taskId);
      if (capability.registrationKey !== externalProjectIdentity(project)) throw fail();
      const task = manager.getTask(taskId);
      if (req.method !== 'POST') throw fail('INPUT_INVALID');
      const body = await readJson(req);
      if (operation === 'roots') {
        const roots = (await service.roots(task.projectId)).filter(root => root.agentCanRead && root.allowModelTransfer);
        json(res, 200, { roots });
      } else if (operation === 'list') {
        json(res, 200, await service.agent(task.projectId, body.rootId, body.path || '', 'list', { cursor: body.cursor ?? null }));
      } else {
        const file = await service.agent(task.projectId, body.rootId, body.path, 'read');
        json(res, 200, { name: file.name, mimeType: file.mimeType, image: file.image, base64: file.bytes.toString('base64') });
      }
      return true;
    },
    async client(req, res, url) {
      const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/(remote-files\/(roots|browse|preview|search)|external-read(?:\/requests(?:\/([^/]+)\/decision)?|\/roots\/([^/]+)\/(toggle|revoke))?)$/);
      const attachment = url.pathname.match(/^\/api\/tasks\/([^/]+)\/remote-files\/prepare-attachment$/);
      if (!match && !attachment) return false;
      const actor = externalActor(access, req);
      if (!actor) throw fail(); // Never expose PC files on an unpaired LAN, even with auth disabled.
      res.setHeader('cache-control', 'no-store');
      if (attachment) {
        if (req.method !== 'POST') throw fail('INPUT_INVALID');
        json(res, 201, await service.prepare(attachment[1], await readJson(req), actor));
        return true;
      }
      const [, projectId, route, action, requestId, rootId, management] = match;
      service.project(projectId);
      if (req.method === 'GET' && action === 'roots') json(res, 200, { roots: await service.roots(projectId), revision: service.project(projectId).externalReadRevision ?? 0 });
      else if (req.method === 'GET' && action === 'browse') json(res, 200, await service.browse(projectId, url.searchParams.get('rootId'), url.searchParams.get('path') || '', { cursor: url.searchParams.get('cursor') }));
      else if (req.method === 'GET' && action === 'search') json(res, 200, await service.search(projectId, url.searchParams.get('rootId'), url.searchParams.get('q') || ''));
      else if (req.method === 'GET' && action === 'preview') {
        const controller = new AbortController();
        const cancel = () => { if (!res.writableFinished) controller.abort(); };
        res.once('close', cancel);
        try {
          const file = await service.preview(projectId, url.searchParams.get('rootId'), url.searchParams.get('path'), { signal: controller.signal });
          json(res, 200, { name: file.name, mimeType: file.mimeType, image: file.image, base64: file.image ? file.bytes.toString('base64') : null, text: file.image ? null : file.bytes.toString('utf8') });
        } finally { res.removeListener('close', cancel); }
      } else if (req.method === 'GET' && route === 'external-read') json(res, 200, await service.settings(projectId, access.local(req)));
      else if (req.method === 'GET' && route === 'external-read/requests') json(res, 200, { requests: service.requests(projectId, access.local(req)) });
      else if (req.method === 'POST' && route === 'external-read/requests') {
        const result = await service.request(projectId, await readJson(req), actor);
        json(res, 201, { ...result, requestedPath: access.local(req) ? result.requestedPath : null });
      } else if (req.method === 'POST' && requestId) {
        if (!access.local(req)) throw fail();
        json(res, 200, await service.decision(projectId, requestId, await readJson(req), actor));
      } else if (req.method === 'POST' && rootId) {
        if (management === 'revoke') {
          if (!access.local(req)) throw fail();
          await service.revoke(projectId, rootId, await readJson(req), actor);
        } else await service.toggle(projectId, rootId, await readJson(req), actor);
        json(res, 200, await service.settings(projectId, access.local(req)));
      } else throw fail('INPUT_INVALID');
      return true;
    },
  };
}
