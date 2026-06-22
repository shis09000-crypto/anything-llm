import { getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback as rawOrFallback } from "@/lib/communication/apiError";

const Invite = {
  checkInvite: async (inviteCode) => {
    return await getJson(`/invite/${inviteCode}`)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { invite: null, error: e.message });
      });
  },
  acceptInvite: async (inviteCode, newUserInfo = {}) => {
    return await postJson(`/invite/${inviteCode}`, newUserInfo)
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
  requestEmailCode: async (inviteCode, email) => {
    return await postJson(`/invite/${inviteCode}/email/request`, { email })
      .then(({ data }) => data)
      .catch((e) => {
        console.error(e);
        return rawOrFallback(e, { success: false, error: e.message });
      });
  },
};

export default Invite;
