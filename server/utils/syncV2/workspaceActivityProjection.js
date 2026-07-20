async function cognitionActivityProjection(client, workspaceId) {
  const [profile, profileState, candidateEvent, evidenceEvent, job] =
    await Promise.all([
      client.workspace_cognitive_profiles.findFirst({
        where: { workspaceId: Number(workspaceId) },
        select: { id: true, revision: true, generatedAt: true },
        orderBy: [{ revision: "desc" }, { id: "desc" }],
      }),
      client.workspace_cognitive_profile_state.findUnique({
        where: { workspaceId: Number(workspaceId) },
        select: {
          dirtyGeneration: true,
          rebuiltGeneration: true,
          rebuildStatus: true,
        },
      }),
      client.workspace_cognitive_candidate_events.findFirst({
        where: { workspaceId: Number(workspaceId) },
        select: { id: true, createdAt: true },
        orderBy: { id: "desc" },
      }),
      client.workspace_cognitive_evidence_events.findFirst({
        where: { workspaceId: Number(workspaceId) },
        select: { id: true, createdAt: true },
        orderBy: { id: "desc" },
      }),
      client.workspace_cognitive_extraction_jobs.findFirst({
        where: { workspaceId: Number(workspaceId) },
        select: { id: true, status: true, updatedAt: true },
        orderBy: { id: "desc" },
      }),
    ]);
  return {
    latestProfileId: profile?.id || null,
    profileRevision: Number(profile?.revision || 0),
    profileGeneratedAt: profile?.generatedAt || null,
    dirtyGeneration: Number(profileState?.dirtyGeneration || 0),
    rebuiltGeneration: Number(profileState?.rebuiltGeneration || 0),
    rebuildStatus: profileState?.rebuildStatus || "idle",
    latestCandidateEventId: candidateEvent?.id || null,
    latestCandidateEventAt: candidateEvent?.createdAt || null,
    latestEvidenceEventId: evidenceEvent?.id || null,
    latestEvidenceEventAt: evidenceEvent?.createdAt || null,
    latestExtractionJobId: job?.id || null,
    latestExtractionJobStatus: job?.status || null,
    latestExtractionJobAt: job?.updatedAt || null,
  };
}

async function meetingActivityProjection(client, workspaceId) {
  const [packet, session, audit] = await Promise.all([
    client.workspace_meeting_packets.findFirst({
      where: { workspaceId: Number(workspaceId) },
      select: {
        id: true,
        revision: true,
        status: true,
        updatedAt: true,
      },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    client.workspace_meeting_sessions.findFirst({
      where: { workspaceId: Number(workspaceId) },
      select: { id: true, status: true, updatedAt: true },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    }),
    client.workspace_meeting_audit_events.findFirst({
      where: { workspaceId: Number(workspaceId) },
      select: { id: true, createdAt: true },
      orderBy: { id: "desc" },
    }),
  ]);
  return {
    latestPacketId: packet?.id || null,
    latestPacketRevision: Number(packet?.revision || 0),
    latestPacketStatus: packet?.status || null,
    latestPacketAt: packet?.updatedAt || null,
    latestSessionId: session?.id || null,
    latestSessionStatus: session?.status || null,
    latestSessionAt: session?.updatedAt || null,
    latestAuditEventId: audit?.id || null,
    latestAuditEventAt: audit?.createdAt || null,
  };
}

async function agentActivityProjection(client, workspaceId) {
  const latest = await client.workspace_agent_invocations.findFirst({
    where: { workspace_id: Number(workspaceId) },
    select: {
      id: true,
      uuid: true,
      clientTurnId: true,
      thread_id: true,
      closed: true,
      lastUpdatedAt: true,
    },
    orderBy: { id: "desc" },
  });
  return {
    latestInvocationId: latest?.id || null,
    latestInvocationUuid: latest?.uuid || null,
    latestClientTurnId: latest?.clientTurnId || null,
    latestThreadId: latest?.thread_id || null,
    latestInvocationClosed: latest?.closed ?? null,
    latestInvocationAt: latest?.lastUpdatedAt || null,
  };
}

module.exports = {
  agentActivityProjection,
  cognitionActivityProjection,
  meetingActivityProjection,
};
