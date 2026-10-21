// PoC: расширение, которое ПАДАЕТ в before_agent_start. Нужно, чтобы проверить,
// что ошибка хука не превращается в бесконечный повтор и не теряет сообщение.
export default function brokenExtension(pi) {
  pi.on('before_agent_start', async () => {
    throw new Error('PoC: намеренная ошибка before_agent_start');
  });
}
