const fs = require("fs");
const path = require("path");

describe("AI Operations NATS provisioning", () => {
  test("allows the operations client to acknowledge JetStream deliveries", () => {
    const script = fs.readFileSync(
      path.resolve(
        __dirname,
        "../../../docker/scripts/provision-ai-operations-secrets.sh"
      ),
      "utf8"
    );

    expect(script).toContain('"\\$JS.ACK.>"');
  });
});
