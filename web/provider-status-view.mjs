// Provider account presentation. The caller owns model selection and refresh requests.
function providerStatusForModel(statuses, model) {
  const provider = String(model?.provider || '').trim().toLowerCase();
  return provider ? statuses?.[provider] || null : null;
}

export function renderProviderStatus(el, statuses, model) {
  // A refresh in flight owns the line: the poll must not overwrite the loader.
  if (!el || el.dataset.refreshing === '1') return;
  const status = providerStatusForModel(statuses, model);
  let text = '';
  if (status?.available) text = providerStatusText(status);
  else if (status?.reason === 'not-fetched') text = 'Нажмите, чтобы обновить данные провайдера';
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle('hidden', !text);
}

function providerStatusText(status) {
  if (status.kind === 'balance' && status.provider === 'deepseek') return deepseekStatusText(status);
  if (status.kind === 'subscription' && status.provider === 'wormsoft') return wormsoftStatusText(status);
  if (status.kind === 'subscription' && status.provider === 'openai-codex') return openAiCodexStatusText(status);
  if (status.kind === 'credits' && status.credits != null) {
    return `${status.label || status.provider}: ${Number(status.credits).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} кредитов${status.stale ? ' · данные устарели' : ''}`;
  }
  return '';
}

function deepseekStatusText(ds) {
  const bal = [];
  if (ds.balance?.cny != null) bal.push(`¥${ds.balance.cny.toFixed(2)}`);
  if (ds.balance?.usd != null) bal.push(`$${ds.balance.usd.toFixed(2)}`);
  const lines = [];
  if (bal.length) {
    if (ds.rub?.total != null) bal.push(`(≈ ${Math.round(ds.rub.total).toLocaleString('ru-RU')} ₽)`);
    lines.push(`DeepSeek: ${bal.join(' · ')}${ds.stale ? ' · данные устарели' : ''}`);
  }
  const days = ds.runway?.historyDays;
  const pace = ds.pace?.historyPerDay;
  const paceRub = ds.pace?.historyPerDayRub;
  const paceParts = [];
  if (pace != null) paceParts.push(`¥${pace.toFixed(1)}`);
  if (paceRub != null) paceParts.push(`≈ ${Math.round(paceRub).toLocaleString('ru-RU')} ₽`);
  const month = ds.pace?.monthlyRub != null ? ` · ~${Math.round(ds.pace.monthlyRub).toLocaleString('ru-RU')} ₽/мес` : '';
  const paceLabel = paceParts.length ? ` (расход ~${paceParts.join('/день ')}/день${month})` : (month ? ` (${month.slice(3)})` : '');
  if (days === 0) lines.push(`Средства DeepSeek исчерпаны${paceLabel}`);
  else if (days != null) lines.push(`Хватит примерно на ${days} дн.${paceLabel}`);
  return lines.join('\n');
}

function openAiCodexStatusText(status) {
  const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
  const limit = (key, label) => status.limits?.[key]?.remainingPercent != null
    ? `${label}: ${number(status.limits[key].remainingPercent)}% осталось`
    : null;
  const credits = status.resetCredits?.available != null ? `сбросов: ${status.resetCredits.available}` : null;
  const parts = [limit('fiveHour', '5 ч'), limit('weekly', '7 дн.'), credits].filter(Boolean);
  return parts.length ? `OpenAI Codex: ${parts.join(' · ')}${status.stale ? ' · данные устарели' : ''}` : '';
}

function wormsoftStatusText(status) {
  const sub = status.subscription || {};
  const number = value => Number(value).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const lines = [];
  if (sub.remaining != null) {
    const total = sub.total != null ? ` из ${number(sub.total)}` : '';
    const percent = sub.remainingRatio != null && sub.remaining > 0 ? ` (${Math.round(sub.remainingRatio * 100)}%)` : '';
    lines.push(`WormSoft: осталось ${number(sub.remaining)}${total} кредитов${percent}${status.stale ? ' · данные устарели' : ''}`);
  } else if (status.stale) {
    lines.push('WormSoft: данные устарели');
  }
  const usage = status.usage;
  const clock = value => new Date(value).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const minutesToReset = usage?.nextResetAt != null
    ? Math.round((new Date(usage.nextResetAt).getTime() - Date.now()) / 60_000)
    : null;
  if (minutesToReset > 0) {
    // The refresh moment is the point of the line: more credits arrive there,
    // so the verdict says whether the measured supply reaches it. A standalone
    // "запаса хватит на N ч" is redundant next to that verdict.
    const verdict = usage?.perDay != null && sub.remaining != null
      ? ((sub.remaining * 24 / usage.perDay) * 60 >= minutesToReset
        ? ' · запаса до сброса хватает'
        : ' · запаса до сброса не хватит')
      : '';
    lines.push(`сброс лимитов в ${clock(usage.nextResetAt)} (замер)${verdict}`);
  } else if (usage?.perDay != null && sub.remaining != null) {
    // No measured reset yet: the supply duration is the only honest figure,
    // and the note explains why the reset time is absent rather than guessed.
    // An exhausted counter (possibly negative after an overrun) has no supply
    // to speak of — negative hours would read as nonsense.
    if (sub.remaining <= 0) {
      lines.push('кредиты исчерпаны (сброс не измерен)');
    } else {
      const hoursOfSupply = (sub.remaining * 24) / usage.perDay;
      const supply = hoursOfSupply >= 48
        ? `~${number(Math.round(hoursOfSupply / 24))} дн.`
        : `~${number(Math.round(hoursOfSupply))} ч`;
      lines.push(`запаса хватит на ${supply} (сброс не измерен)`);
    }
  }
  return lines.join('\n');
}
