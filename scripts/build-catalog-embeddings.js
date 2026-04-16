import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const catalogPath = path.join(rootDir, "data", "catalog.json");
const outputPath = path.join(rootDir, "data", "catalog-embeddings.json");

const openAiApiKey = process.env.OPENAI_API_KEY || "";
const embeddingModel = process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
const batchSize = Math.max(1, Math.min(Number(process.env.EMBEDDINGS_BATCH_SIZE) || 50, 100));

async function main() {
  if (!openAiApiKey) {
    throw new Error("OPENAI_API_KEY is required to build embeddings.");
  }

  const catalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  const products = Array.isArray(catalog.products) ? catalog.products : [];

  if (products.length === 0) {
    throw new Error("Catalog is empty. Run npm run import:catalog first.");
  }

  const documents = products.map((product) => ({
    id: String(product.id || "").trim(),
    sourceId: String(product.sourceId || "").trim(),
    name: String(product.name || "").trim(),
    searchText: buildSearchText(product)
  }));

  const dimensions = [];
  const items = [];

  for (let index = 0; index < documents.length; index += batchSize) {
    const batch = documents.slice(index, index + batchSize);
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openAiApiKey}`
      },
      body: JSON.stringify({
        model: embeddingModel,
        input: batch.map((item) => item.searchText)
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI embeddings error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const vectors = Array.isArray(data?.data) ? data.data : [];

    if (vectors.length !== batch.length) {
      throw new Error("Embeddings response size does not match batch size.");
    }

    for (let offset = 0; offset < batch.length; offset += 1) {
      const vector = Array.isArray(vectors[offset]?.embedding) ? vectors[offset].embedding : [];
      dimensions.push(vector.length);
      items.push({
        id: batch[offset].id,
        sourceId: batch[offset].sourceId,
        name: batch[offset].name,
        searchText: batch[offset].searchText,
        embedding: vector
      });
    }

    console.log(`Embedded ${Math.min(index + batch.length, documents.length)} / ${documents.length}`);
  }

  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        model: embeddingModel,
        dimensions: dimensions[0] || 0,
        items
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Saved embeddings for ${items.length} products to ${outputPath}`);
}

function buildSearchText(product) {
  return String(product?.searchText || "").trim() || fallbackSearchText(product);
}

function fallbackSearchText(product) {
  const variants = Array.isArray(product?.variants)
    ? product.variants.map((variant) =>
        [
          variant?.title,
          variant?.price,
          variant?.unit,
          ...Object.entries(variant?.options || {}).flatMap(([key, entryValue]) => [key, entryValue])
        ]
          .map((item) => String(item || "").trim())
          .filter(Boolean)
          .join(" ")
      )
    : [];

  return [
    product?.name,
    product?.category,
    ...(Array.isArray(product?.categories) ? product.categories : []),
    product?.description,
    product?.shortDescription,
    ...(Array.isArray(product?.applications) ? product.applications : []),
    ...(Array.isArray(product?.colors) ? product.colors : []),
    product?.thickness,
    product?.materialType,
    product?.leatherType,
    product?.origin,
    product?.finish,
    product?.minimumOrder,
    product?.priceFrom,
    product?.unit,
    ...variants
  ]
    .map((item) => String(item || "").trim())
    .filter(Boolean)
    .join(". ");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
