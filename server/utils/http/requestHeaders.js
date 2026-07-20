function readRequestHeader(request, name) {
  if (!request || !name) return undefined;
  if (typeof request.header === "function") return request.header(name);
  if (typeof request.get === "function") return request.get(name);

  const expected = String(name).toLowerCase();
  const headers = request.headers || {};
  const entry = Object.entries(headers).find(
    ([headerName]) => String(headerName).toLowerCase() === expected
  );
  if (!entry) return undefined;
  return Array.isArray(entry[1]) ? entry[1][0] : entry[1];
}

module.exports = { readRequestHeader };
