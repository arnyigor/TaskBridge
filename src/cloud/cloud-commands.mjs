import fs from 'node:fs/promises';
import path from 'node:path';

const COMMAND_ID = /^[A-Za-z0-9_-]{1,160}$/;
const permanent = message => Object.assign(new Error(message), { code: 'INPUT_INVALID', permanent: true });
const taskSummary = task => task && ({ id: task.id, title: task.title, prompt: task.prompt, status: task.status,
  projectId: task.projectId, createdAt: task.createdAt, updatedAt: task.updatedAt, current: task.current,
  error: task.error, errorCode: task.errorCode });
const stateSummary = state => state && ({ isStreaming: state.isStreaming, isCompacting: state.isCompacting,
  messageCount: state.messageCount, model: state.model, thinkingLevel: state.thinkingLevel,
  autoCompactionEnabled: state.autoCompactionEnabled });

export class CloudCommandDispatcher {
  constructor(manager, dataRoot, publishResult, options = {}) {
    this.manager = manager;
    this.publishResult = publishResult;
    this.file = path.join(dataRoot, 'cloud', 'cloud-state.json');
    this.limit = Number(options.processedCommandLimit || 2000);
    this.processed = [];
    this.known = new Set();
    this.chain = Promise.resolve();
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const state = await fs.readFile(this.file, 'utf8').then(JSON.parse, error => error.code === 'ENOENT' ? {} : Promise.reject(error));
    this.processed = Array.isArray(state.processedCommands) ? state.processedCommands.filter(id => typeof id === 'string').slice(-this.limit) : [];
    this.known = new Set(this.processed);
  }

  async #remember(id) {
    if (!this.known.has(id)) this.processed.push(id);
    this.processed = this.processed.slice(-this.limit);
    this.known = new Set(this.processed);
    const temporary = `${this.file}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify({ processedCommands: this.processed }, null, 2)}\n`, 'utf8');
    await fs.rename(temporary, this.file);
  }

  dispatch(command) {
    const next = this.chain.then(() => this.#dispatch(command));
    this.chain = next.catch(() => {});
    return next;
  }

  async #dispatch(command) {
    if (!command || !COMMAND_ID.test(command.id || '') || typeof command.type !== 'string') throw permanent('Некорректная cloud-команда.');
    if (this.known.has(command.id)) return { duplicate: true };
    const payload = command.payload && typeof command.payload === 'object' ? command.payload : {};
    let result;
    let cloudResult;
    switch (command.type) {
      case 'START_TASK': {
        if (!COMMAND_ID.test(command.taskId || '')) throw permanent('START_TASK требует корректный taskId.');
        const existing = this.manager.getTask(command.taskId);
        if (existing && (existing.projectId !== payload.projectId || existing.prompt !== payload.prompt)) throw permanent('taskId уже занят другой локальной задачей.');
        result = existing || await this.manager.createTask(payload, { requestedId: command.taskId });
        cloudResult = taskSummary(result);
        break;
      }
      case 'ABORT_TASK':
        result = await this.manager.cancel(command.taskId);
        cloudResult = taskSummary(result);
        break;
      case 'FOLLOW_UP':
        result = await this.manager.message(command.taskId, payload.text, payload.mode || 'auto', [], null);
        cloudResult = taskSummary(result);
        break;
      case 'COMPACT':
        result = await this.manager.compact(command.taskId, payload.instructions || '');
        break;
      case 'GET_STATE':
        result = { task: taskSummary(this.manager.getTask(command.taskId)), state: stateSummary(await this.manager.state(command.taskId)) };
        break;
      case 'SYNC_STATE':
        result = {
          machineStatus: 'ONLINE', projects: this.manager.listProjects().map(({ id, name }) => ({ id, name })), activeTaskId: this.manager.activeTaskId,
          queuedTaskIds: [...this.manager.queue], tasks: this.manager.listTasks().slice(0, 100).map(taskSummary)
        };
        break;
      default:
        throw permanent(`Неизвестная cloud-команда: ${command.type}`);
    }
    await this.#remember(command.id);
    await this.publishResult(command, { ok: true, result: cloudResult ?? result });
    return { duplicate: false, result };
  }
}
