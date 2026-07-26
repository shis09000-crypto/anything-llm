function boundedDuration(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function waitForSettlement(promise, timeoutMs) {
  if (!promise) return Promise.resolve(true);
  const bounded = boundedDuration(timeoutMs, 0);
  if (bounded <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), bounded);
    timer.unref?.();
    Promise.resolve(promise).then(
      () => finish(true),
      () => finish(true)
    );
  });
}

class CognitionWorkerLifecycle {
  constructor({ recover, tick, scanSilence, isBusy, onRecoveryError }) {
    this.recover = recover;
    this.tick = tick;
    this.scanSilence = scanSilence;
    this.isBusy = isBusy;
    this.onRecoveryError = onRecoveryError;
    this.workerTimer = null;
    this.silenceTimer = null;
    this.startupTimer = null;
    this.recoveryPromise = null;
  }

  start({ tickMs = 15_000, silenceMs = 60_000, startupMs = 1_000 } = {}) {
    if (this.workerTimer) return false;
    this.recoveryPromise = Promise.resolve()
      .then(() => this.recover())
      .catch((error) => this.onRecoveryError?.(error))
      .finally(() => {
        this.recoveryPromise = null;
      });
    this.workerTimer = setInterval(
      () => void Promise.resolve(this.tick()).catch(() => null),
      tickMs
    );
    this.silenceTimer = setInterval(
      () => void Promise.resolve(this.scanSilence()).catch(() => null),
      silenceMs
    );
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null;
      void Promise.resolve(this.tick()).catch(() => null);
    }, startupMs);
    this.workerTimer.unref?.();
    this.silenceTimer.unref?.();
    this.startupTimer.unref?.();
    return true;
  }

  async stop({ timeoutMs = 30_000 } = {}) {
    if (this.workerTimer) clearInterval(this.workerTimer);
    if (this.silenceTimer) clearInterval(this.silenceTimer);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.workerTimer = null;
    this.silenceTimer = null;
    this.startupTimer = null;
    const deadline = Date.now() + boundedDuration(timeoutMs, 30_000);
    await waitForSettlement(
      this.recoveryPromise,
      Math.max(deadline - Date.now(), 0)
    );
    while (this.isBusy() && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return !this.isBusy();
  }

  snapshot() {
    return {
      running: Boolean(this.workerTimer),
      recovering: Boolean(this.recoveryPromise),
      busy: Boolean(this.isBusy()),
    };
  }
}

module.exports = { CognitionWorkerLifecycle, waitForSettlement };
