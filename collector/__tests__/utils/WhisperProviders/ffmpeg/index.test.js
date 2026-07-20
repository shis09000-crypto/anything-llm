process.env.STORAGE_DIR = "test-storage";
const fs = require("fs");
const path = require("path");

// Mock fix-path as a noop to prevent SIGSEGV (segfault)
// Returns ESM-style default export for dynamic import()
jest.mock("fix-path", () => ({ default: jest.fn() }));

const { FFMPEGWrapper } = require("../../../../utils/WhisperProviders/ffmpeg");

function pcmWavFixture({ sampleRate = 8_000, samples = 800 } = {}) {
  const dataBytes = samples * 2;
  const buffer = Buffer.alloc(44 + dataBytes);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataBytes, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataBytes, 40);
  return buffer;
}

const describeRunner = process.env.GITHUB_ACTIONS ? describe.skip : describe;

describeRunner("FFMPEGWrapper", () => {
  /** @type { import("../../../../utils/WhisperProviders/ffmpeg/index").FFMPEGWrapper } */
  let ffmpeg;
  const testDir = path.resolve(__dirname, "../../../../storage/tmp");
  const inputPath = path.resolve(testDir, "test-input.wav");
  const outputPath = path.resolve(testDir, "test-output.wav");

  beforeEach(() => {
    ffmpeg = new FFMPEGWrapper();
  });

  afterEach(() => {
    if (fs.existsSync(inputPath)) fs.rmSync(inputPath);
    if (fs.existsSync(outputPath)) fs.rmSync(outputPath);
  });

  it("should find ffmpeg executable", async () => {
    const knownPath = await ffmpeg.ffmpegPath();
    expect(knownPath).toBeDefined();
    expect(typeof knownPath).toBe("string");
    expect(knownPath.length).toBeGreaterThan(0);
  });

  it("should validate ffmpeg executable", async () => {
    const knownPath = await ffmpeg.ffmpegPath();
    expect(ffmpeg.isValidFFMPEG(knownPath)).toBe(true);
  });

  it("should return false for invalid ffmpeg path", () => {
    expect(ffmpeg.isValidFFMPEG("/invalid/path/to/ffmpeg")).toBe(false);
  });

  it("should convert audio file to wav format", async () => {
    if (!fs.existsSync(testDir)) fs.mkdirSync(testDir, { recursive: true });

    fs.writeFileSync(inputPath, pcmWavFixture());

    const result = await ffmpeg.convertAudioToWav(inputPath, outputPath);

    expect(result).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);

    const stats = fs.statSync(outputPath);
    expect(stats.size).toBeGreaterThan(0);
  }, 30000);

  it("should throw error when conversion fails", () => {
    const nonExistentFile = path.resolve(testDir, "non-existent-file.wav");
    const outputPath = path.resolve(testDir, "test-output-fail.wav");

    expect(async () => {
      return await ffmpeg.convertAudioToWav(nonExistentFile, outputPath);
    }).rejects.toThrow(`Input file ${nonExistentFile} does not exist.`);
  });
});
