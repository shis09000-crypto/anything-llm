import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { resources } from "./resources.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const frontendSrc = path.resolve(__dirname, "..");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  resources.en.common.common.productName === "Athena",
  "Expected en.common.productName to be Athena"
);
assert(
  resources.zh.common.common.productName === "Athena",
  "Expected zh.common.productName to be Athena"
);
assert(
  resources.en.common.common.defaultSiteTitle ===
    "Athena | Knowledge Operating System",
  "Expected en.common.defaultSiteTitle to use the Athena positioning"
);
assert(
  resources.zh.common.common.defaultSiteTitle ===
    "Athena | Knowledge Operating System",
  "Expected zh.common.defaultSiteTitle to use the Athena positioning"
);

const userVisibleEntryFiles = [
  "pages/OnboardingFlow/Steps/Home/index.jsx",
  "components/Modals/Password/SingleUserAuth.jsx",
  "components/Modals/Password/MultiUserAuth.jsx",
  "pages/GeneralSettings/Settings/components/CustomAppName/index.jsx",
  "pages/GeneralSettings/Settings/components/CustomSiteSettings/index.jsx",
];

for (const relativePath of userVisibleEntryFiles) {
  const contents = fs.readFileSync(
    path.join(frontendSrc, relativePath),
    "utf8"
  );
  assert(
    !contents.includes("AnythingLLM"),
    `Unexpected hardcoded AnythingLLM in ${relativePath}`
  );
}

console.log("Branding translation checks passed.");
