/* eslint-env jest */

jest.mock("../../utils/scheduler", () => ({
  schedulerControl: () => ({
    addScheduledJob() {},
    removeScheduledJob() {},
    syncScheduledJob() {},
  }),
}));

const { scheduledJobBelongsTo } = require("../../endpoints/scheduledJobs");

describe("scheduled job ownership", () => {
  test("requires both local and shared-auth owner identities", () => {
    const job = { ownerUserId: 7, ownerAuthUserId: 19 };

    expect(scheduledJobBelongsTo(job, { id: 7, authUserId: 19 })).toBe(true);
    expect(scheduledJobBelongsTo(job, { id: 8, authUserId: 19 })).toBe(false);
    expect(scheduledJobBelongsTo(job, { id: 7, authUserId: 20 })).toBe(false);
    expect(scheduledJobBelongsTo(job, null)).toBe(false);
  });

  test("fails closed for legacy ownerless tasks", () => {
    expect(
      scheduledJobBelongsTo(
        { ownerUserId: null, ownerAuthUserId: null },
        { id: 7, authUserId: 19 }
      )
    ).toBe(false);
  });
});
