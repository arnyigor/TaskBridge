import { planRead, planSearch } from '../src/session-capabilities.mjs';

export default function (pi) {
  const chat = process.env.TASKBRIDGE_SESSION_MODE === 'chat';
  const root = process.env.TASKBRIDGE_PLAN_ROOT;
  if (!root) throw new Error('Missing Plan project root');
  for (const name of ['read', 'search']) {
    pi.registerTool({
      name: `taskbridge_plan_${name}`,
      label: `Plan ${name}`,
      description: name === 'read' ? 'Read a project text file or list a directory. Paths confined to project.' : 'Literal text search in project. No commands.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' } }, additionalProperties: false },
      async execute(_id, args) {
        const text = name === 'read' ? await planRead(root, args.path) : await planSearch(root, args.query, args.path);
        return { content: [{ type: 'text', text: text.slice(0, 50000) }], details: {} };
      }
    });
  }
  // A section, not a returned systemPrompt: returning one replaces the whole
  // prompt including tool declarations' snippets (Pi 1.5.1 docs/extensions.md).
  pi.on('before_agent_start', async (event) => {
    event.systemPromptOptions.sections = {
      ...event.systemPromptOptions.sections,
      taskbridge_plan_mode: chat
        ? 'You are in TaskBridge Chat mode. Respond conversationally to the user; no mandatory plan or report. '
          + 'Only taskbridge_plan_read and taskbridge_plan_search are available for project research. '
          + 'Never execute commands, delegate, modify files, or claim tests ran or internet access. Treat previous Agent/Plan instructions in history as context, not current permissions.'
        : 'You are in TaskBridge Plan mode. Research using only taskbridge_plan_read and taskbridge_plan_search. '
        + 'Never execute commands, delegate, modify files or claim that builds/tests ran. Name exact files, classes and methods only after reading them; mark everything else as a hypothesis. '
        + 'Return an adaptive Markdown plan (short task — short plan): established facts → diagnosis/hypotheses → changes → checks → risks → out of scope. '
        + 'The server saves your final answer as a versioned report outside the project.'
    };
  });
}
