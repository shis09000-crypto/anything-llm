function createProviderAdapter(delegate, overrides = {}) {
  if (
    !delegate ||
    (typeof delegate !== "object" && typeof delegate !== "function")
  )
    throw new TypeError("provider_adapter_delegate_required");

  return new Proxy(delegate, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property))
        return Reflect.get(overrides, property, overrides);

      const value = Reflect.get(target, property, target);
      // Provider implementations use private class methods. Those methods must
      // execute with the original instance as their receiver; an Object.create
      // facade or an unbound Proxy receiver fails JavaScript's private-brand
      // check before the remote execution method is reached.
      return typeof value === "function" ? value.bind(target) : value;
    },
    set(target, property, value) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        overrides[property] = value;
        return true;
      }
      return Reflect.set(target, property, value, target);
    },
    has(target, property) {
      return (
        Object.prototype.hasOwnProperty.call(overrides, property) ||
        Reflect.has(target, property)
      );
    },
  });
}

module.exports = { createProviderAdapter };
