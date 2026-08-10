import assert from "node:assert/strict";
import test from "node:test";

import { isSameRouteOutlet } from "./outletIdentity.js";

const outlet = (child, type = "OutletContext.Provider", key = null) => ({
  type,
  key,
  props: { children: child },
});

test("different route trees are not hidden by the shared outlet provider", () => {
  const cryptoRoute = { type: "CryptoCenter", key: null };
  const workspaceRoute = { type: "WorkspaceChat", key: null };

  assert.equal(
    isSameRouteOutlet(outlet(cryptoRoute), outlet(workspaceRoute)),
    false
  );
});

test("a recreated provider around the same route tree remains equivalent", () => {
  const workspaceRoute = { type: "WorkspaceChat", key: null };

  assert.equal(
    isSameRouteOutlet(outlet(workspaceRoute), outlet(workspaceRoute)),
    true
  );
});

test("different wrapper type or key always identifies a new outlet", () => {
  const route = { type: "WorkspaceChat", key: null };

  assert.equal(isSameRouteOutlet(outlet(route), outlet(route, "Other")), false);
  assert.equal(
    isSameRouteOutlet(outlet(route), outlet(route, undefined, "b")),
    false
  );
});
