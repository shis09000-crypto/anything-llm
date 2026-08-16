export function promptSnapshotsEqual(left, right) {
  return (
    left?.value === right?.value &&
    left?.cursorPositionStart === right?.cursorPositionStart &&
    left?.cursorPositionEnd === right?.cursorPositionEnd
  );
}

export function appendPromptUndoSnapshot(stack, snapshot, maxSize = 100) {
  if (!Array.isArray(stack) || !snapshot) return false;
  if (promptSnapshotsEqual(stack[stack.length - 1], snapshot)) return false;
  if (stack.length >= maxSize) stack.shift();
  stack.push(snapshot);
  return true;
}
