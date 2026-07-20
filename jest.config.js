export default {
  testPathIgnorePatterns: [
    "/node_modules/",
    "/dist-desktop/",
    "/frontend/dist/",
    "/server/public/",
    "/server/generated/",
    "/ios/.*/target/",
  ],
  modulePathIgnorePatterns: [
    "<rootDir>/dist-desktop/",
    "<rootDir>/frontend/dist/",
    "<rootDir>/server/public/",
    "<rootDir>/server/generated/",
    "<rootDir>/ios/.*/target/",
  ],
};
