function lazyDataAccessFacade(domain) {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === "then") return undefined;
        const { DataAccessCenter } = require("./index");
        const facade = DataAccessCenter?.[domain];
        if (!facade) {
          const error = new Error(
            `DataAccess facade is not available: ${domain}`
          );
          error.code = "DATA_ACCESS_FACADE_NOT_AVAILABLE";
          throw error;
        }
        const value = facade[property];
        return typeof value === "function" ? value.bind(facade) : value;
      },
    }
  );
}

function dataAccessFacadeValue(domain, property) {
  const { DataAccessCenter } = require("./index");
  const facade = DataAccessCenter?.[domain];
  if (!facade) {
    const error = new Error(`DataAccess facade is not available: ${domain}`);
    error.code = "DATA_ACCESS_FACADE_NOT_AVAILABLE";
    throw error;
  }
  return facade[property];
}

function lazyDataAccessProperty(domain, property) {
  return new Proxy(function lazyDataAccessPropertyProxy() {}, {
    get(_target, nestedProperty) {
      if (nestedProperty === "then") return undefined;
      const value = dataAccessFacadeValue(domain, property);
      const nestedValue = value?.[nestedProperty];
      return typeof nestedValue === "function"
        ? nestedValue.bind(value)
        : nestedValue;
    },
    apply(_target, thisArg, args) {
      const value = dataAccessFacadeValue(domain, property);
      return value.apply(thisArg, args);
    },
  });
}

module.exports = { lazyDataAccessFacade, lazyDataAccessProperty };
