const MASKED_MEMORY_TEXT = "••••••••";

async function authUserIdForShadowUser(client, shadowUserId) {
  const user = await client.users.findUnique({
    where: { id: Number(shadowUserId) },
    select: { authUserId: true },
  });
  return Number(user?.authUserId || 0) || null;
}

async function shadowUserIdForAuthUser(client, authUserId) {
  const user = await client.users.findFirst({
    where: { authUserId: Number(authUserId) },
    select: { id: true },
  });
  return Number(user?.id || 0) || null;
}

async function memoryCandidatesProjection(client, authUserId) {
  const [count, latest] = await Promise.all([
    client.memory_candidates.count({ where: { userId: Number(authUserId) } }),
    client.memory_candidates.findFirst({
      where: { userId: Number(authUserId) },
      select: { id: true, createdAt: true },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    }),
  ]);
  return {
    count,
    latestCandidateId: latest?.id || null,
    latestCandidateAt: latest?.createdAt || null,
  };
}

async function structuredMemoryProjection(client, authUserId) {
  const rows = await client.user_memory_blocks.findMany({
    where: { userId: Number(authUserId) },
    select: {
      id: true,
      category: true,
      title: true,
      detail: true,
      source: true,
      confidence: true,
      updatedAt: true,
      isSensitive: true,
    },
    orderBy: [{ category: "asc" }, { id: "asc" }],
  });
  return rows.map((row) => ({
    ...row,
    title: row.isSensitive ? MASKED_MEMORY_TEXT : row.title,
    detail: row.isSensitive ? MASKED_MEMORY_TEXT : row.detail,
  }));
}

async function personaMemoryProjection(client, authUserId) {
  return (
    (await client.user_profile_overviews.findFirst({
      where: { userId: Number(authUserId) },
      select: { overview: true, version: true, generatedAt: true },
      orderBy: [{ version: "desc" }, { id: "desc" }],
    })) || { overview: null, version: 0, generatedAt: null }
  );
}

module.exports = {
  authUserIdForShadowUser,
  memoryCandidatesProjection,
  personaMemoryProjection,
  shadowUserIdForAuthUser,
  structuredMemoryProjection,
};
