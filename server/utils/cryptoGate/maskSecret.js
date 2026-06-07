function maskSecret(value) {
  if (!value) return null;
  const text = String(value);
  if (text.length <= 8) return `${text.slice(0, 2)}****${text.slice(-2)}`;
  return `${text.slice(0, 4)}****${text.slice(-4)}`;
}

module.exports = {
  maskSecret,
};
