/**
 * Recovery script: restore embedding vectors from batch output files
 * into LanceDB and re-create document_vectors + workspace_documents records.
 *
 * Usage: node scripts/recover-vectors.js
 * Requires: STORAGE_DIR to be set (from .env or process.env)
 */

const fs = require("fs");
const path = require("path");
const { v4: uuidv4 } = require("uuid");

// ── Ensure STORAGE_DIR is set ──────────────────────────────────────────────
const storageDir =
  process.env.STORAGE_DIR || path.resolve(__dirname, "../storage");
process.env.STORAGE_DIR = storageDir;

const BATCH_DIR = path.join(storageDir, "embedding-batches");

// ── Load batch jobs from SQLite via Prisma ─────────────────────────────────
async function getBatchJobs() {
  const { EmbeddingBatchJob } = require("../models/embeddingBatchJob");
  return await EmbeddingBatchJob.where({ status: "completed" });
}

// ── Read JSONL file into array of objects ───────────────────────────────────
function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

// ── Read manifest (keyed by docId) ──────────────────────────────────────────
function readManifest(jobId) {
  const manifestPath = path.join(BATCH_DIR, `${jobId}.manifest.json`);
  if (!fs.existsSync(manifestPath)) return {};
  return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
}

// ── Strips <document_metadata>...</document_metadata> from chunk text ───────
function stripMetadataTags(text = "") {
  return text.replace(
    /<document_metadata>[\s\S]*?<\/document_metadata>\s*/g,
    ""
  );
}

// ── Main recovery ───────────────────────────────────────────────────────────
async function recover() {
  console.log("Storage dir:", storageDir);
  console.log("Batch dir:", BATCH_DIR);

  const jobs = await getBatchJobs();
  console.log(`\nFound ${jobs.length} completed batch jobs`);

  // Connect to LanceDB
  const { LanceDb } = require("../utils/vectorDbProviders/lance");
  const vectorDb = new LanceDb();
  const { client } = await vectorDb.connect();

  // Load prisma for SQLite writes
  const prisma = require("../utils/prisma");

  let totalVectorsInserted = 0;
  let totalDocVectorsCreated = 0;
  let totalWorkspaceDocsCreated = 0;

  for (const job of jobs) {
    console.log(`\n── Processing job ${job.jobId} ──`);
    console.log(`  Workspace: ${job.workspaceSlug} (id: ${job.workspaceId})`);
    console.log(`  Documents: ${job.documentIds.length}`);

    const manifest = readManifest(job.jobId);
    const inputs = readJsonl(path.join(BATCH_DIR, `${job.jobId}.jsonl`));
    const outputs = readJsonl(
      path.join(BATCH_DIR, `${job.jobId}.output.jsonl`)
    );

    console.log(
      `  Input lines: ${inputs.length}, Output lines: ${outputs.length}`
    );

    if (inputs.length !== outputs.length) {
      console.warn(
        `  ⚠️  Input/output count mismatch, will pair by index only`
      );
    }

    // Build docId -> docMetadata lookup from manifest
    const docMetaByDocId = {};
    for (const [docId, entry] of Object.entries(manifest)) {
      docMetaByDocId[docId] = {
        docpath: entry.docpath,
        title: entry.data?.title || "",
        url: entry.data?.url || "",
        description: entry.data?.description || "",
        docAuthor: entry.data?.docAuthor || "",
        docSource: entry.data?.docSource || "",
        chunkSource: entry.data?.chunkSource || "",
        published: entry.data?.published || "",
        wordCount: entry.data?.wordCount ?? null,
        token_count_estimate: entry.data?.token_count_estimate ?? null,
      };
    }

    // Ensure workspace_documents exist for each document
    for (const docId of job.documentIds) {
      const existing = await prisma.workspace_documents.findFirst({
        where: { docId },
      });
      if (!existing) {
        const meta = docMetaByDocId[docId] || {};
        const docPath =
          meta.docpath ||
          job.documentPaths[0] ||
          "custom-documents/unknown.json";
        await prisma.workspace_documents.create({
          data: {
            docId,
            filename: meta.title || docId,
            docpath: docPath,
            workspaceId: job.workspaceId,
            metadata: JSON.stringify(meta),
            embeddingStatus: "completed",
            embeddingBatchJobId: job.jobId,
          },
        });
        totalWorkspaceDocsCreated++;
        console.log(`  ✓ Created workspace_document for ${docId}`);
      } else {
        console.log(`  - workspace_document for ${docId} already exists`);
      }
    }

    // Build vectors from input+output pairs
    const submissions = [];
    const docVectorRecords = [];

    for (let i = 0; i < Math.min(inputs.length, outputs.length); i++) {
      const input = inputs[i];
      const output = outputs[i];

      if (!input || !output) continue;
      if (output.error) {
        console.warn(`  ⚠️  Output line ${i} has error:`, output.error);
        continue;
      }

      // Parse custom_id: "doc:<docId>:chunk:<chunkNum>"
      const customId = output.custom_id || input.custom_id;
      const match = customId?.match(/^doc:(.+):chunk:(\d+)$/);
      if (!match) {
        console.warn(`  ⚠️  Cannot parse custom_id: ${customId}`);
        continue;
      }

      const [, docId, chunkNum] = match;
      const chunkText = stripMetadataTags(input.body?.input || "");
      const embedding = output.response?.body?.data?.[0]?.embedding;
      if (!embedding) {
        console.warn(`  ⚠️  No embedding for ${customId}`);
        continue;
      }

      const meta = docMetaByDocId[docId] || {};
      const vectorId = uuidv4();

      submissions.push({
        id: vectorId,
        vector: embedding,
        text: chunkText,
        title: meta.title || docId,
        url: meta.url || "",
        docAuthor: meta.docAuthor || "",
        description: meta.description || "",
        docSource: meta.docSource || "",
        chunkSource: meta.chunkSource || "",
        published: meta.published || "",
        wordCount: meta.wordCount,
        token_count_estimate: meta.token_count_estimate,
        docId: docId,
        docpath: meta.docpath || "",
        chunkIndex: parseInt(chunkNum),
      });

      docVectorRecords.push({ docId, vectorId });
    }

    if (submissions.length === 0) {
      console.log(`  No vectors to insert for this job`);
      continue;
    }

    // Insert into LanceDB
    const namespace = job.workspaceSlug;
    const hasNamespace = await vectorDb.hasNamespace(namespace);
    await vectorDb.updateOrCreateCollection(client, submissions, namespace);
    console.log(
      `  ✓ ${hasNamespace ? "Added" : "Created"} ${
        submissions.length
      } vectors ${hasNamespace ? "to existing" : "in new"} LanceDB table '${namespace}'`
    );
    totalVectorsInserted += submissions.length;

    // Create document_vectors records (skip duplicates)
    for (const record of docVectorRecords) {
      const existing = await prisma.document_vectors.findFirst({
        where: { vectorId: record.vectorId },
      });
      if (!existing) {
        await prisma.document_vectors.create({
          data: {
            docId: record.docId,
            vectorId: record.vectorId,
          },
        });
        totalDocVectorsCreated++;
      }
    }
    console.log(
      `  ✓ Created ${docVectorRecords.length} document_vectors records`
    );
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n═══════════════════════════════════════`);
  console.log(`Recovery complete:`);
  console.log(`  Vectors in LanceDB:    ${totalVectorsInserted}`);
  console.log(`  document_vectors rows: ${totalDocVectorsCreated}`);
  console.log(`  workspace_documents:   ${totalWorkspaceDocsCreated}`);

  // Verify
  const tables = await client.tableNames();
  console.log(`\nLanceDB tables: ${tables.join(", ") || "(none)"}`);
  for (const tableName of tables) {
    const table = await client.openTable(tableName);
    const count = await table.countRows();
    console.log(`  ${tableName}: ${count} rows`);
  }
}

recover()
  .then(() => {
    console.log("\nDone.");
    process.exit(0);
  })
  .catch((err) => {
    console.error("Recovery failed:", err);
    process.exit(1);
  });
