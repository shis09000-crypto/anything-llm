const path = require("path");
const cheerio = require("cheerio");
const AdmZip = require("adm-zip");

function decodeZipHref(value = "") {
  const withoutFragment = String(value || "").split("#")[0];
  try {
    return decodeURIComponent(withoutFragment);
  } catch {
    return withoutFragment;
  }
}

function normalizeZipPath(value = "") {
  return path.posix
    .normalize(String(value || "").replace(/\\/g, "/"))
    .replace(/^\/+/, "");
}

function resolveZipHref(baseDir = "", href = "") {
  return normalizeZipPath(path.posix.join(baseDir, decodeZipHref(href)));
}

function zipEntryByPath(zip, targetPath) {
  const normalized = normalizeZipPath(targetPath);
  return zip
    .getEntries()
    .find((entry) => normalizeZipPath(entry.entryName) === normalized);
}

function zipEntryText(zip, targetPath) {
  const entry = zipEntryByPath(zip, targetPath);
  if (!entry || entry.isDirectory) return "";
  return entry.getData().toString("utf8");
}

function readEpubPackage(zip) {
  const containerXml = zipEntryText(zip, "META-INF/container.xml");
  if (!containerXml) return null;
  const $container = cheerio.load(containerXml, { xmlMode: true });
  const opfPath = $container("rootfile").first().attr("full-path");
  if (!opfPath) return null;
  const normalizedOpfPath = normalizeZipPath(opfPath);
  const opfText = zipEntryText(zip, normalizedOpfPath);
  if (!opfText) return null;

  const opfDir = path.posix.dirname(normalizedOpfPath);
  const baseDir = opfDir === "." ? "" : opfDir;
  const $opf = cheerio.load(opfText, { xmlMode: true });
  const manifest = new Map();
  $opf("manifest item").each((_, element) => {
    const node = $opf(element);
    const id = node.attr("id");
    const href = node.attr("href");
    if (!id || !href) return;
    manifest.set(id, {
      id,
      href,
      path: resolveZipHref(baseDir, href),
      mediaType: node.attr("media-type") || "",
      properties: String(node.attr("properties") || "")
        .split(/\s+/)
        .filter(Boolean),
    });
  });

  const spine = [];
  $opf("spine itemref").each((_, element) => {
    const node = $opf(element);
    const idref = node.attr("idref");
    if (!idref) return;
    spine.push({
      idref,
      linear: node.attr("linear") || "yes",
      item: manifest.get(idref),
    });
  });

  let coverId = "";
  $opf("metadata meta").each((_, element) => {
    const node = $opf(element);
    if (String(node.attr("name") || "").toLowerCase() === "cover")
      coverId = node.attr("content") || coverId;
  });

  return { baseDir, coverId, manifest, spine };
}

function epubCoverImageBuffer(originalPath) {
  const zip = new AdmZip(originalPath);
  const pkg = readEpubPackage(zip);
  if (!pkg) return null;

  const manifestItems = [...pkg.manifest.values()];
  const coverItem =
    (pkg.coverId && pkg.manifest.get(pkg.coverId)) ||
    manifestItems.find((item) => item.properties.includes("cover-image")) ||
    manifestItems.find(
      (item) =>
        /^image\//i.test(item.mediaType) &&
        /cover|封面/i.test(`${item.id} ${item.href}`)
    );
  if (!coverItem) return null;
  const entry = zipEntryByPath(zip, coverItem.path);
  if (!entry || entry.isDirectory) return null;
  return entry.getData();
}

module.exports = {
  epubCoverImageBuffer,
  readEpubPackage,
  zipEntryByPath,
  zipEntryText,
};
