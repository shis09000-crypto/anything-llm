const PDFJS_PUBLIC_BASE = `${import.meta.env.BASE_URL || "/"}`.replace(
  /\/?$/,
  "/"
);
const PDFJS_ASSET_BASE = `${PDFJS_PUBLIC_BASE}pdfjs/`;
const THUMBNAIL_TIMEOUT_MS = 4_000;
const THUMBNAIL_MAX_WIDTH = 360;
const THUMBNAIL_MAX_HEIGHT = 520;
const THUMBNAIL_JPEG_QUALITY = 0.88;

function withTimeout(
  promise,
  timeoutMs = THUMBNAIL_TIMEOUT_MS,
  fallback = null
) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = window.setTimeout(() => resolve(fallback), timeoutMs);
    }),
  ]).finally(() => window.clearTimeout(timer));
}

export async function thumbnailFromPdfBlob(blob) {
  if (!blob?.size) return null;
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf");
  pdfjs.GlobalWorkerOptions.workerSrc = `${PDFJS_ASSET_BASE}pdf.worker.min.js`;
  const loadingTask = pdfjs.getDocument({
    data: await blob.arrayBuffer(),
    cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
  });
  const pdfDocument = await loadingTask.promise;
  try {
    const page = await pdfDocument.getPage(1);
    const baseViewport = page.getViewport({ scale: 1 });
    const scale = Math.min(
      THUMBNAIL_MAX_WIDTH / Math.max(1, baseViewport.width),
      THUMBNAIL_MAX_HEIGHT / Math.max(1, baseViewport.height),
      1
    );
    const viewport = page.getViewport({ scale });
    const canvas = window.document.createElement("canvas");
    const context = canvas.getContext("2d", { alpha: false });
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    await page.render({ canvasContext: context, viewport }).promise;
    return canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY);
  } finally {
    pdfDocument.destroy?.();
  }
}

export function imageBlobToThumbnailDataUrl(blob) {
  return withTimeout(
    new Promise((resolve, reject) => {
      let imageUrl = null;
      let image = null;
      const cleanup = () => {
        if (imageUrl) URL.revokeObjectURL(imageUrl);
        if (image) {
          image.onload = null;
          image.onerror = null;
        }
      };

      if (!blob?.size) {
        resolve(null);
        return;
      }
      imageUrl = URL.createObjectURL(blob);
      image = new Image();
      image.onload = () => {
        try {
          const ratio = Math.min(
            THUMBNAIL_MAX_WIDTH / Math.max(1, image.naturalWidth),
            THUMBNAIL_MAX_HEIGHT / Math.max(1, image.naturalHeight),
            1
          );
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(image.naturalWidth * ratio));
          canvas.height = Math.max(1, Math.round(image.naturalHeight * ratio));
          const context = canvas.getContext("2d", { alpha: false });
          context.fillStyle = "#ffffff";
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY));
        } catch (error) {
          reject(error);
        } finally {
          cleanup();
        }
      };
      image.onerror = () => {
        cleanup();
        reject(new Error("Cover image failed to load."));
      };
      image.src = imageUrl;
    }),
    THUMBNAIL_TIMEOUT_MS,
    null
  );
}

export async function thumbnailFromEpubBlob(blob) {
  if (!blob?.size) return null;
  const { default: ePub } = await import("epubjs");
  const book = ePub(await blob.arrayBuffer(), {
    openAs: "binary",
    replacements: "blobUrl",
  });
  try {
    return await thumbnailFromEpubBook(book);
  } finally {
    book.destroy?.();
  }
}

export async function thumbnailFromEpubBook(book) {
  if (!book) return null;
  const coverThumbnail = await thumbnailFromEpubCover(book);
  if (coverThumbnail) return coverThumbnail;
  return await thumbnailFromEpubFirstSpine(book);
}

async function thumbnailFromEpubCover(book) {
  const coverUrl = await withTimeout(book.coverUrl(), THUMBNAIL_TIMEOUT_MS);
  if (!coverUrl) return null;
  const response = await withTimeout(fetch(coverUrl), THUMBNAIL_TIMEOUT_MS);
  if (!response?.ok) return null;
  const blob = await response.blob();
  if (!blob?.size) return null;
  return await imageBlobToThumbnailDataUrl(blob);
}

async function thumbnailFromEpubFirstSpine(book) {
  await withTimeout(book.ready || book.opened, THUMBNAIL_TIMEOUT_MS);
  const section = firstLinearSpineSection(book);
  if (!section) return null;

  let html = null;
  try {
    html = await withTimeout(
      section.render(book.load.bind(book)),
      THUMBNAIL_TIMEOUT_MS
    );
  } finally {
    section.unload?.();
  }
  if (!html) return null;

  const document = new DOMParser().parseFromString(html, "text/html");
  const imageUrl = await firstImageUrlFromEpubSection(document, section, book);
  if (imageUrl) {
    const response = await withTimeout(fetch(imageUrl), THUMBNAIL_TIMEOUT_MS);
    if (response?.ok) {
      const blob = await response.blob();
      const thumbnail = await imageBlobToThumbnailDataUrl(blob);
      if (thumbnail) return thumbnail;
    }
  }

  return textThumbnailFromEpubSection(document, book);
}

function firstLinearSpineSection(book) {
  const items = book?.spine?.spineItems || [];
  return items.find((item) => item?.linear !== "no") || book?.spine?.first?.();
}

async function firstImageUrlFromEpubSection(document, section, book) {
  const image = document.querySelector("img[src], image[href]");
  const rawSrc = image?.getAttribute("src") || image?.getAttribute("href");
  if (!rawSrc) return null;
  if (/^(blob:|data:|https?:|\/)/i.test(rawSrc)) return rawSrc;

  const resolvedPath = resolveEpubRelativePath(
    section.url || section.href,
    rawSrc
  );
  if (!resolvedPath) return null;
  if (book.archived) return await book.archive?.createUrl?.(resolvedPath);
  return book.resolve?.(resolvedPath) || resolvedPath;
}

function resolveEpubRelativePath(basePath, href) {
  if (!basePath || !href) return href || null;
  try {
    return new URL(href, `https://epub.local/${basePath}`).pathname.replace(
      /^\//,
      ""
    );
  } catch {
    return href;
  }
}

function textThumbnailFromEpubSection(document, book) {
  const title =
    book?.packaging?.metadata?.title ||
    document.querySelector("title")?.textContent?.trim() ||
    "EPUB";
  const bodyText = (document.body?.textContent || "")
    .replace(/\s+/g, " ")
    .trim();
  const subtitle = bodyText.slice(0, 80);
  const canvas = window.document.createElement("canvas");
  canvas.width = THUMBNAIL_MAX_WIDTH;
  canvas.height = THUMBNAIL_MAX_HEIGHT;
  const context = canvas.getContext("2d", { alpha: false });
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = "#dbeafe";
  context.lineWidth = 10;
  context.strokeRect(20, 20, canvas.width - 40, canvas.height - 40);
  context.fillStyle = "#111827";
  context.font = "600 30px serif";
  drawWrappedText(context, title, 48, 96, canvas.width - 96, 40, 5);
  if (subtitle) {
    context.fillStyle = "#4b5563";
    context.font = "18px serif";
    drawWrappedText(context, subtitle, 48, 330, canvas.width - 96, 28, 4);
  }
  return canvas.toDataURL("image/jpeg", THUMBNAIL_JPEG_QUALITY);
}

function drawWrappedText(context, text, x, y, maxWidth, lineHeight, maxLines) {
  const chars = Array.from(text || "");
  let line = "";
  let lines = 0;
  for (const char of chars) {
    const nextLine = `${line}${char}`;
    if (context.measureText(nextLine).width > maxWidth && line) {
      context.fillText(line, x, y);
      y += lineHeight;
      lines += 1;
      line = char;
      if (lines >= maxLines) return;
    } else {
      line = nextLine;
    }
  }
  if (line && lines < maxLines) context.fillText(line, x, y);
}
