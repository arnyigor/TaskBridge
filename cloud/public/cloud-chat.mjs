export function assistantContent(message) {
  if (typeof message?.content === 'string') return { text: message.content, thinking: '' };
  const content = Array.isArray(message?.content) ? message.content : [];
  return {
    text: content.filter(item => item?.type === 'text').map(item => item.text || '').join(''),
    thinking: content.filter(item => item?.type === 'thinking').map(item => item.thinking || '').join('')
  };
}

export function buildTurns(task, events) {
  const turns = [];
  if (task?.prompt) turns.push({ kind: 'user', text: task.prompt });
  let assistant = null;

  const ensureAssistant = () => {
    if (!assistant) {
      assistant = { kind: 'assistant', text: '', thinking: '', tools: [] };
      turns.push(assistant);
    }
    return assistant;
  };

  for (const event of events) {
    if (event.type === 'USER_MESSAGE') {
      const text = event.data?.text || event.message || '';
      const previous = turns.at(-1);
      if (text && !(previous?.kind === 'user' && previous.text === text)) turns.push({ kind: 'user', text });
      assistant = null;
      continue;
    }

    const pi = event.data?.pi;
    if (!pi) continue;
    if (pi.type === 'message_start' && pi.message?.role === 'assistant') {
      ensureAssistant();
    } else if (pi.type === 'message_update') {
      const delta = pi.assistantMessageEvent;
      if (delta?.type === 'text_delta') ensureAssistant().text += delta.delta || '';
      if (delta?.type === 'thinking_delta') ensureAssistant().thinking += delta.delta || '';
    } else if (pi.type === 'message_end' && pi.message?.role === 'assistant') {
      const final = assistantContent(pi.message);
      const turn = ensureAssistant();
      if (final.text) turn.text = final.text;
      if (final.thinking) turn.thinking = final.thinking;
    } else if (pi.type === 'tool_execution_start') {
      ensureAssistant().tools.push({ id: pi.toolCallId, name: pi.toolName || 'tool', args: pi.args, status: 'running' });
    } else if (pi.type === 'tool_execution_end') {
      const turn = ensureAssistant();
      let tool = [...turn.tools].reverse().find(item => (pi.toolCallId && item.id === pi.toolCallId) || (!pi.toolCallId && item.name === pi.toolName));
      if (!tool) {
        tool = { id: pi.toolCallId, name: pi.toolName || 'tool', args: null };
        turn.tools.push(tool);
      }
      tool.status = pi.isError ? 'error' : 'done';
    }
  }
  return turns;
}
