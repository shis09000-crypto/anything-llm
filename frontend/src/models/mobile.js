import { deleteJson, getJson, postJson } from "@/lib/communication/apiClient";
import { apiErrorFallback } from "@/lib/communication/apiError";

/**
 * @typedef {Object} MobileConnection
 * @property {string} id - The database ID of the device.
 * @property {string} deviceId - The device ID of the device.
 * @property {string} deviceOs - The operating system of the device.
 * @property {boolean} approved - Whether the device is approved.
 * @property {string} createdAt - The date and time the device was created.
 */

const MobileConnection = {
  /**
   * Get the connection info for the mobile app.
   * @returns {Promise<{connectionUrl: string|null}>} The connection info.
   */
  getConnectionInfo: async function () {
    return await getJson("/mobile/connect-info")
      .then(({ data }) => data)
      .catch((e) => apiErrorFallback(e, false));
  },

  /**
   * Get all the devices from the database.
   * @returns {Promise<MobileDevice[]>} The devices.
   */
  getDevices: async function () {
    return await getJson("/mobile/devices")
      .then(({ data }) => data)
      .then((res) => res.devices || [])
      .catch(() => []);
  },

  /**
   * Delete a device from the database.
   * @param {string} deviceId - The database ID of the device to delete.
   * @returns {Promise<{message: string}>} The deleted device.
   */
  deleteDevice: async function (id) {
    return await deleteJson(`/mobile/${id}`)
      .then(({ data }) => data)
      .catch((e) => apiErrorFallback(e, false));
  },

  /**
   * Update a device in the database.
   * @param {string} id - The database ID of the device to update.
   * @param {Object} updates - The updates to apply to the device.
   * @returns {Promise<{updates: MobileDevice}>} The updated device.
   */
  updateDevice: async function (id, updates = {}) {
    return await postJson(`/mobile/update/${id}`, updates)
      .then(({ data }) => data)
      .catch((e) => apiErrorFallback(e, false));
  },
};

export default MobileConnection;
