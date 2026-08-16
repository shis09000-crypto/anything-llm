export function nextTrustedAvatar(
  currentAvatar,
  refreshedAvatar,
  { authoritative = false } = {}
) {
  if (
    !authoritative &&
    (refreshedAvatar === null || refreshedAvatar === undefined)
  ) {
    return currentAvatar;
  }
  return refreshedAvatar ?? null;
}
