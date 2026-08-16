const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const root = path.resolve(__dirname, "..");
const lock = JSON.parse(
  fs.readFileSync(path.join(root, "browser-egress-core-lock.json"), "utf8")
);
const selected =
  process.argv
    .find((arg) => arg.startsWith("--platforms="))
    ?.slice("--platforms=".length)
    .split(",")
    .filter(Boolean) || [];
const privateKeyFile = process.env.ATHENA_BROWSER_EGRESS_CORE_SIGNING_KEY_FILE;
const archiveDirectory = process.env.ATHENA_BROWSER_EGRESS_CORE_ARCHIVE_DIR
  ? path.resolve(process.env.ATHENA_BROWSER_EGRESS_CORE_ARCHIVE_DIR)
  : null;
if (!privateKeyFile)
  throw new Error("ATHENA_BROWSER_EGRESS_CORE_SIGNING_KEY_FILE is required");
const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyFile));
if (privateKey.asymmetricKeyType !== "ml-dsa-65")
  throw new Error("Browser egress core signing key must be ML-DSA-65");
const publicKey = crypto.createPublicKey(privateKey);
const publicPem = publicKey.export({ type: "spki", format: "pem" });
const publicKeySha256 = crypto
  .createHash("sha256")
  .update(publicKey.export({ type: "spki", format: "der" }))
  .digest("hex");

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

async function download(url, destination) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "Athena-Browser-Egress-Builder/1.0" },
    signal: AbortSignal.timeout(180_000),
  });
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);
  fs.writeFileSync(destination, Buffer.from(await response.arrayBuffer()), {
    mode: 0o600,
  });
}

async function prepare(target) {
  const asset = lock.assets[target];
  if (!asset) throw new Error(`Unsupported browser egress target: ${target}`);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "athena-egress-core-"));
  try {
    const cachedArchive = archiveDirectory
      ? path.join(archiveDirectory, asset.archive)
      : null;
    const archive = cachedArchive || path.join(temporary, asset.archive);
    if (cachedArchive) {
      if (!fs.existsSync(cachedArchive))
        throw new Error(`Cached archive is missing for ${target}`);
    } else {
      await download(
        `https://github.com/SagerNet/sing-box/releases/download/v${lock.version}/${asset.archive}`,
        archive
      );
    }
    if (sha256(archive) !== asset.sha256)
      throw new Error(`Archive SHA-256 mismatch for ${target}`);
    const extracted = path.join(temporary, "extracted");
    fs.mkdirSync(extracted);
    if (asset.archive.endsWith(".zip"))
      execFileSync("unzip", ["-q", archive, "-d", extracted]);
    else execFileSync("tar", ["-xzf", archive, "-C", extracted]);
    const binaryName = target.startsWith("win32") ? "sing-box.exe" : "sing-box";
    const candidates = [];
    const walk = (directory) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (entry.name === binaryName) candidates.push(file);
      }
    };
    walk(extracted);
    if (candidates.length !== 1)
      throw new Error(`Expected one ${binaryName} for ${target}`);
    const output = path.join(root, "browser-egress", target);
    fs.rmSync(output, { recursive: true, force: true });
    fs.mkdirSync(output, { recursive: true, mode: 0o700 });
    const binary = path.join(output, binaryName);
    fs.copyFileSync(candidates[0], binary);
    if (!target.startsWith("win32")) fs.chmodSync(binary, 0o500);
    const statement = {
      schemaVersion: "athena-browser-egress-core:v1",
      version: lock.version,
      platform: target.split("-")[0],
      arch: target.split("-")[1],
      file: binaryName,
      sha256: sha256(binary),
    };
    const signature = crypto.sign(null, Buffer.from(JSON.stringify(statement)), privateKey);
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      `${JSON.stringify({
        ...statement,
        mldsa65PublicKey: publicPem,
        mldsa65Signature: signature.toString("base64"),
      })}\n`,
      { mode: 0o600 }
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

(async () => {
  if (!selected.length) throw new Error("At least one --platforms target is required");
  for (const target of selected) await prepare(target);
  const directory = path.join(root, "browser-egress");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(directory, "trust.json"),
    `${JSON.stringify({
      schemaVersion: "athena-browser-egress-core-trust:v1",
      publicKeySha256,
    })}\n`,
    { mode: 0o600 }
  );
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
