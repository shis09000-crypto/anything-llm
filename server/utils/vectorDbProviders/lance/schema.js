function defaultValueForSchemaField(field = {}) {
  const type = field.type?.toString?.() || "";
  if (type === "Utf8" || type === "LargeUtf8") return "";
  if (
    type.includes("Int") ||
    type.includes("Float") ||
    type.includes("Decimal")
  )
    return 0;
  if (type === "Bool") return false;
  return undefined;
}

function normalizeRowsForSchema(data = [], schema = null) {
  if (!schema?.fields?.length) return data;

  return data.map((row) => {
    const normalized = { ...row };
    for (const field of schema.fields) {
      if (Object.prototype.hasOwnProperty.call(normalized, field.name))
        continue;

      const defaultValue = defaultValueForSchemaField(field);
      if (defaultValue === undefined) continue;
      normalized[field.name] = defaultValue;
    }
    return normalized;
  });
}

module.exports = { defaultValueForSchemaField, normalizeRowsForSchema };
