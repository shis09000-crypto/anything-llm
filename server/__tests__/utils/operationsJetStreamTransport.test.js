const {
  deliverySubject,
  subjectForSemanticEvent,
} = require("../../utils/operations/jetStreamTransport");

describe("operations JetStream transport", () => {
  test("uses a stable delivery subject for a durable queue consumer", () => {
    expect(deliverySubject("athena-ops-live-acceptance")).toBe(
      "_INBOX.ATHENA.OPERATIONS.athena-ops-live-acceptance"
    );
    expect(deliverySubject("unsafe.consumer/value")).toBe(
      "_INBOX.ATHENA.OPERATIONS.unsafe-consumer-value"
    );
  });

  test("keeps semantic event subjects scoped by environment and category", () => {
    expect(
      subjectForSemanticEvent(
        { category: "agent_tool" },
        {
          ATHENA_NATS_SERVERS: "nats://127.0.0.1:4222",
          ATHENA_OPERATIONS_NATS_SUBJECT: "operations.semantic.v1",
        }
      )
    ).toBe("athena.development.operations.semantic.v1.agent_tool");
  });
});
