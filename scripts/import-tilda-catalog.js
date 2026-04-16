import { promises as fs } from "fs";
import { execFileSync, spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { XMLParser } from "./xml-parser.js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const defaultInput = path.join(rootDir, "store-11012911-202604121317.xlsx");
const outputPath = path.join(rootDir, "data", "catalog.json");

const inputPath = path.resolve(process.argv[2] || defaultInput);

async function main() {
  const parser = new XMLParser();
  const sharedStrings = parseSharedStrings(parser, readZipEntry("xl/sharedStrings.xml"));
  const workbookRelations = parseWorkbookRelations(parser, readZipEntry("xl/_rels/workbook.xml.rels"));
  const sheetPath = parseFirstSheetPath(parser, readZipEntry("xl/workbook.xml"), workbookRelations);
  const rows = parseSheetRows(parser, readZipEntry(sheetPath), sharedStrings);

  if (rows.length < 2) {
    throw new Error("Excel file does not contain catalog rows.");
  }

  const header = rows[1];
  const records = rows.slice(2).map((row) => rowToObject(header, row));
  const editionsByParent = new Map();

  for (const record of records) {
    const parentUid = value(record["Parent UID"]);
    if (!parentUid) {
      continue;
    }

    const editions = editionsByParent.get(parentUid) || [];
    editions.push(record);
    editionsByParent.set(parentUid, editions);
  }

  const products = records
    .filter((record) => value(record["Tilda UID"]) && !value(record["Parent UID"]))
    .map((record) => mapProduct(record, editionsByParent.get(value(record["Tilda UID"])) || []));

  const catalog = buildCatalog(products);

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(
    outputPath,
    JSON.stringify(
      {
        sourceFile: path.basename(inputPath),
        importedAt: new Date().toISOString(),
        summary: catalog.summary,
        filters: catalog.filters,
        products
      },
      null,
      2
    ) + "\n",
    "utf8"
  );

  console.log(`Imported ${products.length} products into ${outputPath}`);
  runEmbeddingsBuildIfConfigured();
}

function runEmbeddingsBuildIfConfigured() {
  if (process.env.SKIP_EMBEDDINGS === "1") {
    console.log("Skipped embeddings build because SKIP_EMBEDDINGS=1");
    return;
  }

  if (!process.env.OPENAI_API_KEY) {
    console.log("Skipped embeddings build because OPENAI_API_KEY is not set");
    return;
  }

  console.log("Building catalog embeddings...");

  const result = spawnSync(process.execPath, [path.join(__dirname, "build-catalog-embeddings.js")], {
    stdio: "inherit",
    env: process.env
  });

  if (result.status !== 0) {
    throw new Error("Catalog imported, but embeddings build failed.");
  }
}

function readZipEntry(entryPath) {
  return execFileSync("unzip", ["-p", inputPath, entryPath], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024
  });
}

function parseSharedStrings(parser, xml) {
  if (!xml) {
    return [];
  }

  const items = xml.match(/<si\b[\s\S]*?<\/si>/g) || [];
  return items.map((item) =>
    value(
      [...item.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
        .map((match) => decodeXml(match[1]))
        .join("")
    )
  );
}

function parseWorkbookRelations(parser, xml) {
  const document = parser.parse(xml);
  const relations = new Map();

  for (const relation of document.findAll("Relationships/Relationship")) {
    relations.set(relation.attr("Id"), relation.attr("Target"));
  }

  return relations;
}

function parseFirstSheetPath(parser, xml, relations) {
  const document = parser.parse(xml);
  const firstSheet = document.find("workbook/sheets/sheet");
  const relationId = firstSheet?.attr("r:id");
  const target = relationId ? relations.get(relationId) : "";

  if (!target) {
    throw new Error("Could not resolve first worksheet.");
  }

  return target.startsWith("xl/") ? target : `xl/${target}`;
}

function parseSheetRows(parser, xml, sharedStrings) {
  const document = parser.parse(xml);
  const rows = [];

  for (const row of document.findAll("worksheet/sheetData/row")) {
    const values = [];

    for (const cell of row.findAll("c")) {
      const ref = cell.attr("r");
      const columnIndex = ref ? columnToIndex(ref.replace(/[0-9]/g, "")) : values.length;
      while (values.length < columnIndex) {
        values.push("");
      }

      const type = cell.attr("t");
      const rawValue = cell.find("v")?.text || "";
      values[columnIndex] = type === "s" ? sharedStrings[Number(rawValue)] || "" : rawValue;
    }

    rows.push(values);
  }

  return rows;
}

function rowToObject(header, row) {
  const record = {};

  for (let index = 0; index < header.length; index += 1) {
    record[header[index]] = row[index] || "";
  }

  return record;
}

function mapProduct(record, editions) {
  const categoryParts = splitMulti(record.Category);
  const editionSummaries = editions.map((edition, index) => {
    const options = parseKeyValuePairs(edition.Editions);
    const unit = normalizeUnit(
      Object.entries(options).find(([key]) => key.includes("Единица"))?.[1] || record.Unit
    );
    const priceValue = parseNumber(edition.Price);

    return {
      id: `${value(record["Tilda UID"])}-variant-${index + 1}`,
      title: value(edition.Title),
      price: value(edition.Price),
      priceValue,
      unit,
      options
    };
  });
  const priceFrom = getMinPrice(editions);
  const unit = getPrimaryUnit(record, editionSummaries);
  const purpose = splitMulti(record["Characteristics:Назначение кожи"]);
  const colors = splitMulti(record["Characteristics:Цвет"]);
  const descriptions = [
    toPlainText(record.Description),
    toPlainText(record.Text),
    toPlainText(record["Characteristics:Особенности"])
  ].filter(Boolean);

  const name = value(record.Title);
  const productId = slugify(value(record["Tilda UID"]) || name);
  const slug = slugify(name);
  const description = descriptions.join(". ");
  const category = categoryParts.at(-1) || categoryParts[0] || "";
  const minimumOrder = value(record["Characteristics:Минимальный заказ"]);
  const stock = value(record.Quantity) || "уточнять у менеджера";
  const thicknessValue = value(record["Characteristics:Толщина (мм)"]);
  const primaryPhoto = value(record.Photo);
  const normalizedVariants = editionSummaries.slice(0, 20);

  return {
    id: productId,
    slug,
    sourceId: value(record["Tilda UID"]),
    name,
    category,
    categories: categoryParts,
    description,
    shortDescription: descriptions[0] || "",
    applications: purpose,
    colors,
    thickness: thicknessValue ? `${thicknessValue} мм` : "",
    materialType: value(record["Characteristics:Тип сырья"]),
    leatherType: value(record["Characteristics:Вид кожи"]),
    origin: value(record["Characteristics:Происхождение сырья"]),
    hideSize: value(record["Characteristics:Размер шкур"]),
    finish: value(record["Characteristics:Вид покрытия"]),
    grade: value(record["Characteristics:Сорт"]),
    country: value(record["Characteristics:Страна производства"]),
    minimumOrder,
    stock,
    priceFrom: priceFrom ? formatPrice(priceFrom, unit) : "",
    priceFromValue: priceFrom,
    unit: unit || normalizeUnit(record.Unit),
    url: value(record.Url),
    photo: primaryPhoto,
    photos: splitMulti(record.Photo),
    variants: normalizedVariants,
    attributes: {
      materialType: value(record["Characteristics:Тип сырья"]),
      leatherType: value(record["Characteristics:Вид кожи"]),
      colors,
      applications: purpose,
      thicknessMm: thicknessValue,
      origin: value(record["Characteristics:Происхождение сырья"]),
      hideSize: value(record["Characteristics:Размер шкур"]),
      finish: value(record["Characteristics:Вид покрытия"]),
      grade: value(record["Characteristics:Сорт"]),
      country: value(record["Characteristics:Страна производства"]),
      minimumOrder
    },
    categoryPath: categoryParts.map((item, index) => ({
      id: slugify(item),
      name: item,
      level: index
    })),
    pricing: {
      from: priceFrom,
      fromText: priceFrom ? formatPrice(priceFrom, unit) : "",
      unit: unit || normalizeUnit(record.Unit)
    },
    availability: {
      stock,
      minimumOrder
    },
    media: primaryPhoto
      ? [
          {
            type: "image",
            url: primaryPhoto
          }
        ]
      : [],
    searchText: ""
  };
}

function getPrimaryUnit(record, editions) {
  for (const edition of editions) {
    const editionUnit = normalizeUnit(
      Object.entries(edition.options || {}).find(([key]) => key.includes("Единица"))?.[1]
    );
    if (editionUnit) {
      return editionUnit;
    }
  }

  return normalizeUnit(record.Unit);
}

function getMinPrice(editions) {
  const numbers = editions
    .map((edition) => parseNumber(edition.Price))
    .filter((price) => Number.isFinite(price) && price > 0);

  return numbers.length ? Math.min(...numbers) : null;
}

function formatPrice(price, unit) {
  const formatted = Number.isInteger(price) ? String(price) : price.toFixed(2);
  return unit ? `от ${formatted} / ${unit}` : `от ${formatted}`;
}

function parseKeyValuePairs(text) {
  return splitMulti(text).reduce((accumulator, part) => {
    const [key, ...rest] = part.split(":");
    if (!key || rest.length === 0) {
      return accumulator;
    }

    accumulator[key.trim()] = rest.join(":").trim();
    return accumulator;
  }, {});
}

function splitMulti(text) {
  return value(text)
    .split(";")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseNumber(input) {
  const normalized = value(input).replace(",", ".");
  const parsed = Number.parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function value(input) {
  return decodeXml(String(input || "").trim());
}

function decodeXml(text) {
  return String(text || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function toPlainText(input) {
  return value(input).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function normalizeUnit(input) {
  const unit = value(input);

  if (unit === "FOT") {
    return "фут2";
  }

  return unit;
}

function slugify(input) {
  return value(input)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

function buildCatalog(products) {
  for (const product of products) {
    product.searchText = buildSearchText(product);
  }

  const categoryCounts = countValues(products.flatMap((product) => product.categories));
  const colorCounts = countValues(products.flatMap((product) => product.colors));
  const applicationCounts = countValues(products.flatMap((product) => product.applications));
  const materialCounts = countValues(products.map((product) => product.materialType));
  const leatherTypeCounts = countValues(products.map((product) => product.leatherType));
  const finishCounts = countValues(products.map((product) => product.finish));
  const variantCount = products.reduce(
    (total, product) => total + (Array.isArray(product.variants) ? product.variants.length : 0),
    0
  );
  const prices = products
    .map((product) => product.priceFromValue)
    .filter((price) => Number.isFinite(price) && price > 0);

  return {
    summary: {
      totalProducts: products.length,
      totalVariants: variantCount,
      categoriesCount: categoryCounts.length,
      colorsCount: colorCounts.length,
      minPrice: prices.length ? Math.min(...prices) : null,
      maxPrice: prices.length ? Math.max(...prices) : null
    },
    filters: {
      categories: categoryCounts,
      colors: colorCounts,
      applications: applicationCounts,
      materialTypes: materialCounts,
      leatherTypes: leatherTypeCounts,
      finishes: finishCounts
    }
  };
}

function buildSearchText(product) {
  const variantLines = Array.isArray(product.variants)
    ? product.variants.map((variant) =>
        [
          variant?.title,
          variant?.price,
          variant?.unit,
          ...Object.entries(variant?.options || {}).flatMap(([key, entryValue]) => [key, entryValue])
        ]
          .map(value)
          .filter(Boolean)
          .join(" ")
      )
    : [];

  return [
    product.name,
    product.category,
    ...(Array.isArray(product.categories) ? product.categories : []),
    product.description,
    product.shortDescription,
    ...(Array.isArray(product.applications) ? product.applications : []),
    ...(Array.isArray(product.colors) ? product.colors : []),
    product.thickness,
    product.materialType,
    product.leatherType,
    product.origin,
    product.hideSize,
    product.finish,
    product.grade,
    product.country,
    product.minimumOrder,
    product.priceFrom,
    product.unit,
    ...variantLines,
    buildRussianHints(product)
  ]
    .map(value)
    .filter(Boolean)
    .join(". ");
}

function buildRussianHints(product) {
  const hints = new Set();
  const leatherType = value(product.leatherType).toLowerCase();
  const applications = (Array.isArray(product.applications) ? product.applications : [])
    .map((item) => value(item).toLowerCase())
    .filter(Boolean);

  if (leatherType.includes("замша")) {
    hints.add("натуральная замша");
  }

  if (leatherType.includes("нубук")) {
    hints.add("натуральный нубук");
  }

  if (applications.some((item) => item.includes("одеж"))) {
    hints.add("кожа для одежды");
    hints.add("кожа для курток");
  }

  if (applications.some((item) => item.includes("обув"))) {
    hints.add("кожа для обуви");
  }

  if (applications.some((item) => item.includes("сум"))) {
    hints.add("кожа для сумок");
  }

  return [...hints].join(". ");
}

function countValues(values) {
  const counts = new Map();

  for (const item of values.map(value).filter(Boolean)) {
    counts.set(item, (counts.get(item) || 0) + 1);
  }

  return [...counts.entries()]
    .map(([name, count]) => ({
      id: slugify(name),
      name,
      count
    }))
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name));
}

function columnToIndex(column) {
  let index = 0;

  for (const char of column) {
    index = index * 26 + char.charCodeAt(0) - 64;
  }

  return index - 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
