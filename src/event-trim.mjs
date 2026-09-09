// message_end carries a message's full final content, so every
// message_update (streaming delta) between a message_start and its closing
// message_end is fully superseded once that pair is complete — replaying
// them is pure waste for a bulk/history fetch. A long session can have
// thousands of tiny deltas; dropping the closed ones is what makes loading
// a large history usable instead of shipping megabytes of dead events to
// the browser. Deltas for a message still in progress (no closing
// message_end yet in this batch) are left untouched, so live/in-progress
// text is never lost.
export function trimStreamingDeltas(events) {
  let openSince = -1;
  const closedRanges = [];
  for (let i = 0; i < events.length; i++) {
    const frame = events[i].data?.pi;
    if (!frame) continue;
    if (frame.type === 'message_start') openSince = i;
    else if (frame.type === 'message_end') {
      if (openSince >= 0) closedRanges.push([openSince, i]);
      openSince = -1;
    }
  }
  if (!closedRanges.length) return events;
  const drop = new Set();
  for (const [start, end] of closedRanges) {
    for (let i = start; i < end; i++) {
      if (events[i].data?.pi?.type === 'message_update') drop.add(i);
    }
  }
  return drop.size ? events.filter((_, i) => !drop.has(i)) : events;
}
