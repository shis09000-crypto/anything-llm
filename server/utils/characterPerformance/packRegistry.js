const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validatePack, performanceError, semverAtLeast } = require("./contract");

class PerformancePackRegistry {
  constructor({
    root = path.resolve(__dirname, "../../character-performance-packs"),
    trustedKeyRoot = path.resolve(
      __dirname,
      "../../character-performance-keys"
    ),
    env = process.env,
  } = {}) {
    this.root = root;
    this.trustedKeyRoot = trustedKeyRoot;
    this.env = env;
    this.packs = new Map();
  }

  load() {
    const files = fs.existsSync(this.root)
      ? fs.readdirSync(this.root).filter((file) => file.endsWith(".json"))
      : [];
    const next = new Map();
    for (const file of files) {
      const pack = JSON.parse(
        fs.readFileSync(path.join(this.root, file), "utf8")
      );
      const validation = validatePack(pack, {
        production: this.env.NODE_ENV === "production",
      });
      if (!validation.ok)
        throw performanceError("performance_pack_invalid", 500, {
          file,
          findings: validation.findings,
        });
      if (pack.integrity.signature_algorithm === "ed25519") {
        const keyPath = path.join(
          this.trustedKeyRoot,
          `${pack.integrity.key_id}.pem`
        );
        const signatureValid =
          fs.existsSync(keyPath) &&
          crypto.verify(
            null,
            Buffer.from(pack.integrity.sha256, "hex"),
            fs.readFileSync(keyPath),
            Buffer.from(pack.integrity.signature, "base64")
          );
        if (!signatureValid)
          throw performanceError("performance_pack_signature_invalid", 500, {
            file,
            key_id: pack.integrity.key_id,
          });
      }
      next.set(pack.id, Object.freeze(pack));
    }
    this.packs = next;
    return this;
  }

  get(id) {
    const pack = this.packs.get(String(id || ""));
    if (!pack) throw performanceError("performance_pack_not_found", 404);
    return pack;
  }

  select({
    characterId,
    adapter,
    runtimeVersion,
    manifestRef,
    installedAssets = [],
  } = {}) {
    const installed = new Map(
      installedAssets.map((asset) => [asset.asset_ref, asset.sha256])
    );
    const candidates = [...this.packs.values()].filter(
      (pack) =>
        pack.character_id === characterId &&
        pack.adapter === adapter &&
        pack.manifest_ref.id === manifestRef.id &&
        pack.manifest_ref.version === manifestRef.version &&
        pack.manifest_ref.sha256 === manifestRef.sha256
    );
    if (
      candidates.length &&
      !candidates.some((entry) =>
        semverAtLeast(runtimeVersion, entry.minimum_runtime_version)
      )
    )
      throw performanceError("performance_adapter_version_incompatible", 409);
    const pack = candidates.find(
      (entry) =>
        semverAtLeast(runtimeVersion, entry.minimum_runtime_version) &&
        (entry.asset.asset_ref.startsWith("builtin:") ||
          installed.get(entry.asset.asset_ref) === entry.asset.sha256)
    );
    if (!pack)
      throw performanceError("performance_pack_negotiation_failed", 409);
    return pack;
  }

  list() {
    return [...this.packs.values()];
  }
}

module.exports = { PerformancePackRegistry };
