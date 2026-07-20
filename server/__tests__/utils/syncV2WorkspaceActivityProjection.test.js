const {
  agentActivityProjection,
  cognitionActivityProjection,
  meetingActivityProjection,
} = require("../../utils/syncV2/workspaceActivityProjection");

describe("Sync V2 workspace activity projections", () => {
  test("cognition projection contains cursors but no cognition content", async () => {
    const client = {
      workspace_cognitive_profiles: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      workspace_cognitive_profile_state: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      workspace_cognitive_candidate_events: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      workspace_cognitive_evidence_events: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      workspace_cognitive_extraction_jobs: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await cognitionActivityProjection(client, 4);

    const profileSelect =
      client.workspace_cognitive_profiles.findFirst.mock.calls[0][0].select;
    expect(profileSelect).not.toHaveProperty("profileJson");
    const jobSelect =
      client.workspace_cognitive_extraction_jobs.findFirst.mock.calls[0][0]
        .select;
    expect(jobSelect).not.toHaveProperty("error");
    expect(jobSelect).not.toHaveProperty("payloadJson");
  });

  test("meeting projection excludes frozen packets and audit bodies", async () => {
    const client = {
      workspace_meeting_packets: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      workspace_meeting_sessions: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      workspace_meeting_audit_events: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await meetingActivityProjection(client, 4);

    const packetSelect =
      client.workspace_meeting_packets.findFirst.mock.calls[0][0].select;
    expect(packetSelect).not.toHaveProperty("selectionJson");
    expect(packetSelect).not.toHaveProperty("contentHash");
    const auditSelect =
      client.workspace_meeting_audit_events.findFirst.mock.calls[0][0].select;
    expect(auditSelect).not.toHaveProperty("requestJson");
    expect(auditSelect).not.toHaveProperty("resultJson");
  });

  test("agent projection excludes prompts", async () => {
    const client = {
      workspace_agent_invocations: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    };

    await agentActivityProjection(client, 4);

    const select =
      client.workspace_agent_invocations.findFirst.mock.calls[0][0].select;
    expect(select).not.toHaveProperty("prompt");
    expect(select).not.toHaveProperty("user_id");
    expect(select).toMatchObject({ id: true, uuid: true, closed: true });
  });
});
