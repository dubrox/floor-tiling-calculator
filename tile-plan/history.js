export function createHistory(initial) {
  return {
    past: [],
    present: structuredClone(initial),
    future: [],
  };
}

export function pushHistory(history, next) {
  return {
    past: [...history.past, history.present],
    present: structuredClone(next),
    future: [],
  };
}

export function undoHistory(history) {
  if (!history.past.length) return history;
  const previous = history.past[history.past.length - 1];
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redoHistory(history) {
  if (!history.future.length) return history;
  const next = history.future[0];
  return {
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

export function canUndo(history) {
  return history.past.length > 0;
}

export function canRedo(history) {
  return history.future.length > 0;
}

export function replacePresent(history, next) {
  return {
    ...history,
    present: structuredClone(next),
  };
}
