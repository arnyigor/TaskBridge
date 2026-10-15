import { Metrics } from './metrics.mjs';

// In-process registry of turn-delivery timings (шаг C-C плана улучшений,
// docs/message-delivery-analysis.md §5): where a turn spends its time between
// «оператор отправил сообщение» and «кадр доехал до SSE».
//
//   turn_dispatch_ms   — от старта доставки (сообщение принято к отправке)
//                        до записи команды в stdin Pi;
//   ack_latency_ms     — от записи команды до ACK (ответа RPC, resolve
//                        pi.prompt/sendFollowUp);
//   eventchain_wait_ms — от прихода кадра из stdout Pi до фактической
//                        обработки в #handlePiEvent (очередь eventChain,
//                        включая удержание ACK-барьером);
//   sse_publish_lag_ms — от создания события задачи (event.at) до публикации
//                        в SSE-фан-аут.
//
// Модуль-одиночка: один серверный процесс — один реестр. Тесты создают
// сервер в отдельном процессе (server-fixture), поэтому изоляция не страдает.
export const deliveryMetrics = new Metrics();
