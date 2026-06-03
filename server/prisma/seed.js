const path = require("path");
const fs = require("fs");
const { PrismaClient } = require("@prisma/client");
const { databasePath } = require("../utils/environment");

function sqliteDatasourceUrl() {
  const dbPath = databasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  return new URL(`file:${dbPath}`).toString();
}

const prisma = new PrismaClient({
  datasources: {
    db: {
      url: sqliteDatasourceUrl(),
    },
  },
});

async function main() {
  const settings = [
    { label: "multi_user_mode", value: "false" },
    { label: "logo_filename", value: "anything-llm.png" },
  ];

  for (let setting of settings) {
    const existing = await prisma.system_settings.findUnique({
      where: { label: setting.label },
    });

    // Only create the setting if it doesn't already exist
    if (!existing) {
      await prisma.system_settings.create({
        data: setting,
      });
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
