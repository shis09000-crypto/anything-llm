import showToast from "../toast";
import { trackTtsBlobUrl } from "./blobStats";

const WORKER_IDLE_TIMEOUT_MS = 60_000;

export { revokeTtsBlobUrl } from "./blobStats";

export default class PiperTTSClient {
  static _instance;
  voiceId = "en_US-hfc_female-medium";
  worker = null;
  idleTimer = null;

  constructor({ voiceId } = { voiceId: null }) {
    if (PiperTTSClient._instance) {
      this.voiceId = voiceId !== null ? voiceId : this.voiceId;
      return PiperTTSClient._instance;
    }

    this.voiceId = voiceId !== null ? voiceId : this.voiceId;
    PiperTTSClient._instance = this;
    return this;
  }

  #getWorker() {
    this.#clearIdleTerminate();
    if (!this.worker)
      this.worker = new Worker(new URL("./worker.js", import.meta.url), {
        type: "module",
      });
    return this.worker;
  }

  #clearIdleTerminate() {
    if (!this.idleTimer) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  #scheduleIdleTerminate() {
    this.#clearIdleTerminate();
    this.idleTimer = setTimeout(() => {
      this.worker?.terminate();
      this.worker = null;
      PiperTTSClient._instance = null;
    }, WORKER_IDLE_TIMEOUT_MS);
  }

  /**
   * Get all available voices for a client
   * @returns {Promise<import("@mintplex-labs/piper-tts-web/dist/types").Voice[]}>}
   */
  static async voices() {
    const tmpWorker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    tmpWorker.postMessage({ type: "voices" });
    return new Promise((resolve, reject) => {
      let timeout = null;
      const handleMessage = (event) => {
        if (event.data.type !== "voices") {
          console.log("PiperTTSWorker debug event:", event.data);
          return;
        }
        resolve(event.data.voices);
        tmpWorker.removeEventListener("message", handleMessage);
        timeout && clearTimeout(timeout);
        tmpWorker.terminate();
      };

      timeout = setTimeout(() => {
        tmpWorker.removeEventListener("message", handleMessage);
        tmpWorker.terminate();
        reject("TTS Worker timed out.");
      }, 30_000);
      tmpWorker.addEventListener("message", handleMessage);
    });
  }

  static async flush() {
    const tmpWorker = new Worker(new URL("./worker.js", import.meta.url), {
      type: "module",
    });
    tmpWorker.postMessage({ type: "flush" });
    return new Promise((resolve, reject) => {
      let timeout = null;
      const handleMessage = (event) => {
        if (event.data.type !== "flush") {
          console.log("PiperTTSWorker debug event:", event.data);
          return;
        }
        resolve(event.data.flushed);
        tmpWorker.removeEventListener("message", handleMessage);
        timeout && clearTimeout(timeout);
        tmpWorker.terminate();
      };

      timeout = setTimeout(() => {
        tmpWorker.removeEventListener("message", handleMessage);
        tmpWorker.terminate();
        reject("TTS Worker timed out.");
      }, 30_000);
      tmpWorker.addEventListener("message", handleMessage);
    });
  }

  /**
   * Runs prediction via webworker so we can get an audio blob back.
   * @returns {Promise<{blobURL: string|null, error: string|null}>} objectURL blob: type.
   */
  async waitForBlobResponse() {
    return new Promise((resolve) => {
      let timeout = null;
      const handleMessage = (event) => {
        if (event.data.type === "error") {
          this.worker.removeEventListener("message", handleMessage);
          timeout && clearTimeout(timeout);
          this.#scheduleIdleTerminate();
          return resolve({ blobURL: null, error: event.data.message });
        }

        if (event.data.type !== "result") {
          console.log("PiperTTSWorker debug event:", event.data);
          return;
        }
        const blobURL = trackTtsBlobUrl(
          URL.createObjectURL(event.data.audio),
          event.data.audio?.size || 0
        );
        resolve({
          blobURL,
          error: null,
        });
        this.worker.removeEventListener("message", handleMessage);
        timeout && clearTimeout(timeout);
        this.#scheduleIdleTerminate();
      };

      timeout = setTimeout(() => {
        this.worker?.removeEventListener("message", handleMessage);
        this.#scheduleIdleTerminate();
        resolve({ blobURL: null, error: "PiperTTSWorker Worker timed out." });
      }, 30_000);
      this.worker.addEventListener("message", handleMessage);
    });
  }

  async getAudioBlobForText(textToSpeak, voiceId = null) {
    const primaryWorker = this.#getWorker();
    primaryWorker.postMessage({
      type: "init",
      text: String(textToSpeak),
      voiceId: voiceId ?? this.voiceId,
      // Don't reference WASM because in the docker image
      // the user will be connected to internet (mostly)
      // and it bloats the app size on the frontend or app significantly
      // and running the docker image fully offline is not an intended use-case unlike the app.
    });

    const { blobURL, error } = await this.waitForBlobResponse();
    if (!!error) {
      showToast(
        `Could not generate voice prediction. Error: ${error}`,
        "error",
        { clear: true }
      );
      return;
    }

    return blobURL;
  }
}
