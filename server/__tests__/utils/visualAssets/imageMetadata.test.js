const sharp = require("sharp");
const {
  MAX_IMAGE_EDGE,
  analyzeImageBuffer,
  optimizeImageBuffer,
  validateImageBuffer,
} = require("../../../utils/visualAssets/imageMetadata");

async function solidImage(color, options = {}) {
  return sharp({
    create: {
      width: options.width || 96,
      height: options.height || 96,
      channels: 3,
      background: color,
    },
  })
    .png()
    .toBuffer();
}

describe("visual asset image metadata", () => {
  test("rejects buffers that are not real supported images", async () => {
    const result = await optimizeImageBuffer(Buffer.from("not an image"), {
      scopeType: "workspace",
    });

    expect(result).toEqual({
      valid: false,
      error: "unsupported_image_type",
    });
  });

  test("keeps strict validation for oversized dimensions when not optimizing", async () => {
    const png = await sharp({
      create: {
        width: MAX_IMAGE_EDGE + 10,
        height: 20,
        channels: 3,
        background: "#dbeafe",
      },
    })
      .png()
      .toBuffer();

    expect(validateImageBuffer(png).error).toBe("image_dimensions_too_large");
  });

  test("optimizes oversized but valid uploads into bounded webp assets", async () => {
    const source = await sharp({
      create: {
        width: MAX_IMAGE_EDGE + 600,
        height: 1200,
        channels: 3,
        background: "#dbeafe",
      },
    })
      .jpeg({ quality: 90 })
      .toBuffer();

    const result = await optimizeImageBuffer(source, { scopeType: "node" });

    expect(result.valid).toBe(true);
    expect(result.mime).toBe("image/webp");
    expect(result.ext).toBe(".webp");
    expect(Math.max(result.imageWidth, result.imageHeight)).toBeLessThanOrEqual(
      MAX_IMAGE_EDGE
    );
    expect(result.originalWidth).toBe(MAX_IMAGE_EDGE + 600);
    expect(result.dominantColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.averageColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(result.brightness).toBeGreaterThanOrEqual(0);
    expect(result.brightness).toBeLessThanOrEqual(1);
    expect(["light", "dark", "mixed"]).toContain(result.contrastHint);
    expect(["warm", "cool", "neutral"]).toContain(result.temperatureHint);
    expect(result.themeHint).toMatch(
      /^(light|dark|mixed)-(warm|cool|neutral)$/
    );
  });

  test("classifies bright, dark, warm, and cool uploads for adaptive themes", async () => {
    const bright = await analyzeImageBuffer(await solidImage("#f8fafc"));
    const dark = await analyzeImageBuffer(await solidImage("#111827"));
    const warm = await analyzeImageBuffer(await solidImage("#f2c078"));
    const cool = await analyzeImageBuffer(await solidImage("#9bd4ff"));

    expect(bright.valid).toBe(true);
    expect(bright.contrastHint).toBe("light");
    expect(bright.brightness).toBeGreaterThan(0.7);

    expect(dark.valid).toBe(true);
    expect(dark.contrastHint).toBe("dark");
    expect(dark.brightness).toBeLessThan(0.45);

    expect(warm.valid).toBe(true);
    expect(warm.temperatureHint).toBe("warm");

    expect(cool.valid).toBe(true);
    expect(cool.temperatureHint).toBe("cool");
  });

  test("falls back to safe visual metadata when sharp is unavailable", async () => {
    const source = await solidImage("#dbeafe");
    jest.resetModules();
    jest.doMock("sharp", () => {
      throw new Error("sharp unavailable");
    });
    const {
      optimizeImageBuffer: optimizeWithoutSharp,
    } = require("../../../utils/visualAssets/imageMetadata");

    const result = await optimizeWithoutSharp(source, {
      scopeType: "workspace",
    });

    expect(result.valid).toBe(true);
    expect(result.optimized).toBe(false);
    expect(result.visualAnalysisFallback).toBe(true);
    expect(result.dominantColor).toBe("#dbeafe");
    expect(result.averageColor).toBe("#dbeafe");
    expect(result.contrastHint).toBe("light");

    jest.dontMock("sharp");
    jest.resetModules();
  });
});
