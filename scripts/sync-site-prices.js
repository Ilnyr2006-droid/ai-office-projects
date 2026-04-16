import { promises as fs } from "fs";
import { spawnSync } from "child_process";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const catalogPath = path.join(rootDir, "data", "catalog.json");
const concurrency = normalizeInteger(getArgValue("--concurrency"), 4, { min: 1, max: 12 });
const timeoutMs = normalizeInteger(getArgValue("--timeout"), 15000, { min: 1000, max: 120000 });
const productLimit = normalizeInteger(getArgValue("--limit"), 0, { min: 0, max: 10000 });
const nameFilter = normalizeText(getArgValue("--match"));
const usdToRubRate = normalizePositiveNumber(getArgValue("--usd-to-rub") || process.env.USD_TO_RUB_RATE);
const isDryRun = process.argv.includes("--dry-run");
const isDebugCandidates = process.argv.includes("--debug-candidates");

async function main() {
  const catalog = await readJson(catalogPath);
  const products = Array.isArray(catalog?.products) ? catalog.products : [];

  if (products.length === 0) {
    throw new Error("Catalog is empty. Run import first.");
  }

  const selectedProducts = products
    .filter((product) => product?.url)
    .filter((product) => {
      if (!nameFilter) {
        return true;
      }

      const haystack = normalizeText(
        [product?.name, product?.slug, product?.sourceId, product?.url].filter(Boolean).join(" ")
      );
      return haystack.includes(nameFilter);
    })
    .slice(0, productLimit || undefined);

  if (selectedProducts.length === 0) {
    throw new Error("No products matched the requested filter.");
  }

  const stats = {
    checkedProducts: selectedProducts.length,
    updatedProducts: 0,
    updatedVariants: 0,
    failedProducts: 0,
    skippedProducts: 0
  };

  const logs = [];
  const workItems = selectedProducts.map((product) => async () => {
    try {
      const html = await fetchText(product.url, timeoutMs);
      const extracted = extractPricingFromHtml(html, product);

      if (isDebugCandidates) {
        logDebugCandidates(product, extracted);
      }

      if (!extracted.from && extracted.variantMatches.length === 0) {
        stats.skippedProducts += 1;
        logs.push(`SKIP ${product.name}: не удалось уверенно вытащить цену`);
        return;
      }

      const changed = applyExtractedPricing(product, extracted);

      if (!changed.productChanged && changed.variantChanges === 0) {
        stats.skippedProducts += 1;
        return;
      }

      stats.updatedProducts += changed.productChanged ? 1 : 0;
      stats.updatedVariants += changed.variantChanges;
      logs.push(formatChangeLog(product, changed));
    } catch (error) {
      stats.failedProducts += 1;
      logs.push(`FAIL ${product.name}: ${error.message}`);
    }
  });

  await runWithConcurrency(workItems, concurrency);

  for (const product of products) {
    product.searchText = buildSearchText(product);
  }

  const summary = buildCatalogSummary(products);
  catalog.importedAt = catalog.importedAt || new Date().toISOString();
  catalog.summary = summary.summary;
  catalog.filters = summary.filters;
  catalog.priceSync = {
    syncedAt: new Date().toISOString(),
    source: "https://ozelifkoja.ru/",
    checkedProducts: stats.checkedProducts,
    updatedProducts: stats.updatedProducts,
    updatedVariants: stats.updatedVariants,
    failedProducts: stats.failedProducts,
    skippedProducts: stats.skippedProducts,
    dryRun: isDryRun
  };

  logs.sort((left, right) => left.localeCompare(right, "ru"));
  console.log(`Checked ${stats.checkedProducts} products`);
  console.log(`Updated ${stats.updatedProducts} products and ${stats.updatedVariants} variants`);
  console.log(`Skipped ${stats.skippedProducts} products`);
  console.log(`Failed ${stats.failedProducts} products`);

  if (logs.length) {
    console.log("");
    for (const line of logs) {
      console.log(line);
    }
  }

  if (isDryRun) {
    console.log("");
    console.log("Dry run: catalog.json was not modified");
    return;
  }

  await fs.writeFile(catalogPath, JSON.stringify(catalog, null, 2) + "\n", "utf8");
  console.log("");
  console.log(`Saved updated prices to ${catalogPath}`);
  runEmbeddingsBuildIfConfigured(stats.updatedProducts > 0 || stats.updatedVariants > 0);
}

function extractPricingFromHtml(html, product) {
  const rawCandidates = collectPriceCandidates(html);
  const sanitizedCandidates = rawCandidates.map((candidate) => sanitizeCandidate(candidate, product));
  const filteredCandidates = sanitizedCandidates
    .filter((candidate) => Number.isFinite(candidate.value) && candidate.value > 0)
    .filter((candidate) => candidate.value < 1000000)
    .filter((candidate) => !isSuspiciousRubCandidate(candidate));
  const preferredCandidates = preferCurrencyCandidates(filteredCandidates, "RUB");
  const variantMatches = matchVariants(product, preferredCandidates);
  const primaryVariant = selectPrimaryVariantMatch(product, variantMatches);
  const productCandidate = selectProductLevelCandidate(product, preferredCandidates);
  const from = productCandidate?.value || primaryVariant?.priceValue || null;
  const fromUnit = productCandidate?.unit || primaryVariant?.unit || product?.unit || "";
  const fromCurrency = productCandidate?.currency || primaryVariant?.currency || "";

  return {
    from,
    fromUnit,
    fromCurrency,
    variantMatches,
    debug: {
      rawCandidates,
      sanitizedCandidates,
      filteredCandidates,
      preferredCandidates,
      productCandidate
    }
  };
}

function collectPriceCandidates(html) {
  const candidates = [];
  const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];

  for (const [, attributes, content] of scripts) {
    if (/application\/ld\+json/i.test(attributes || "")) {
      collectJsonCandidates(content, "jsonld", candidates);
      continue;
    }

    if (!content || !/"(?:price|amount|editions|offers|sku|variants?)"/i.test(content)) {
      continue;
    }

    collectJsonCandidates(content, "script-json", candidates);
    collectRegexCandidates(content, "script-regex", candidates);
  }

  collectRegexCandidates(html, "html-regex", candidates);
  return dedupeCandidates(candidates);
}

function collectJsonCandidates(content, source, candidates) {
  for (const jsonText of extractJsonBlocks(content)) {
    const parsed = safeJsonParse(jsonText);
    if (parsed !== null) {
      collectCandidatesFromValue(parsed, source, candidates);
    }
  }
}

function collectCandidatesFromValue(value, source, candidates, breadcrumb = []) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (Array.isArray(value)) {
    for (const entry of value) {
      collectCandidatesFromValue(entry, source, candidates, breadcrumb);
    }
    return;
  }

  const record = value;
  const priceValue = firstFiniteNumber(
    record.price,
    record.lowPrice,
    record.highPrice,
    record.amount,
    record.sale_price,
    record.priceValue
  );

  if (priceValue) {
    const context = [
      record.unitCode,
      record.priceCurrency,
      record.currency,
      record.currencyCode,
      record.unit,
      record.title,
      record.name,
      record.sku,
      record.quantity,
      breadcrumb.join(" ")
    ]
      .filter(Boolean)
      .join(" ");
    candidates.push({
      source,
      value: priceValue,
      unit: inferUnitFromText(context),
      currency: normalizeCurrency(record.priceCurrency || record.currency || record.currencyCode || inferCurrencyFromText(context)),
      currencyExplicit: Boolean(record.priceCurrency || record.currency || record.currencyCode),
      context: stringifySnippet(record)
    });
  }

  for (const [key, entry] of Object.entries(record)) {
    collectCandidatesFromValue(entry, source, candidates, [...breadcrumb, key]);
  }
}

function collectRegexCandidates(content, source, candidates) {
  const patterns = [
    /"(?:price|lowPrice|highPrice|amount|sale_price|priceValue)"\s*:\s*"?([0-9]+(?:[.,][0-9]+)?)"?/gi,
    /(?:data-price|data-product-price(?:-def)?|data-edition-price)\s*=\s*"([0-9]+(?:[.,][0-9]+)?)"/gi,
    /(?:^|[>"'\s])([0-9][0-9\s]{1,8}(?:[.,][0-9]+)?)\s*(?:₽|руб(?:\.|ля|лей)?)/gi
  ];

  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      const priceValue = parseNumber(match[1]);
      if (!priceValue) {
        continue;
      }

      const start = Math.max(0, match.index - 180);
      const end = Math.min(content.length, match.index + match[0].length + 180);
      const context = content.slice(start, end);
      candidates.push({
        source,
        value: priceValue,
        unit: inferUnitFromText(context),
        currency: inferCurrencyFromText(context),
        currencyExplicit: /(?:₽|руб(?:\.|ля|лей)?)/i.test(match[0]),
        context
      });
    }
  }
}

function selectProductLevelCandidate(product, candidates) {
  if (!candidates.length) {
    return null;
  }

  const productName = normalizeText(product?.name);
  const urlSlug = normalizeText(product?.slug);
  const preferredUnit = normalizeUnit(product?.unit);
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreProductCandidate(candidate, { productName, urlSlug, preferredUnit })
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }

      const leftUnitScore = scorePrimaryUnit(left.unit, preferredUnit);
      const rightUnitScore = scorePrimaryUnit(right.unit, preferredUnit);
      if (rightUnitScore !== leftUnitScore) {
        return rightUnitScore - leftUnitScore;
      }

      return right.value - left.value;
    });

  return scored[0] || candidates.slice().sort((left, right) => right.value - left.value)[0] || null;
}

function selectPrimaryVariantMatch(product, variantMatches) {
  if (!Array.isArray(variantMatches) || variantMatches.length === 0) {
    return null;
  }

  const preferredUnit = normalizeUnit(product?.unit);
  const sorted = variantMatches.slice().sort((left, right) => {
    const leftUnitScore = scorePrimaryUnit(left.unit, preferredUnit);
    const rightUnitScore = scorePrimaryUnit(right.unit, preferredUnit);

    if (rightUnitScore !== leftUnitScore) {
      return rightUnitScore - leftUnitScore;
    }

    return right.priceValue - left.priceValue;
  });

  return sorted[0] || null;
}

function scorePrimaryUnit(unit, preferredUnit) {
  const normalizedUnit = normalizeUnit(unit);
  if (preferredUnit && normalizedUnit === preferredUnit) {
    return 3;
  }

  if (normalizedUnit === "фут2") {
    return 2;
  }

  if (normalizedUnit === "дм2") {
    return 1;
  }

  return 0;
}

function scoreProductCandidate(candidate, productProfile) {
  const context = normalizeText(candidate.context);
  let score = 0;

  if (candidate.source === "jsonld") {
    score += 4;
  } else if (candidate.source === "script-json") {
    score += 3;
  } else {
    score += 1;
  }

  if (productProfile.productName && context.includes(productProfile.productName)) {
    score += 4;
  }

  if (productProfile.urlSlug && context.includes(productProfile.urlSlug)) {
    score += 2;
  }

  if (candidate.unit) {
    score += 1;
  }

  if (productProfile.preferredUnit && candidate.unit === productProfile.preferredUnit) {
    score += 3;
  }

  if (candidate.currency === "RUB") {
    score += 6;
  }

  score += scoreAreaUnitValueFit(candidate.unit, candidate.value);

  return score;
}

function matchVariants(product, candidates) {
  if (!Array.isArray(product?.variants) || product.variants.length === 0) {
    return [];
  }

  return product.variants
    .map((variant, index) => {
      const match = selectVariantCandidate(variant, candidates);
      if (!match) {
        return null;
      }

      return {
        index,
        priceValue: match.value,
        price: formatPlainPrice(match.value),
        unit: match.unit || variant?.unit || "",
        currency: match.currency || "",
        source: match.source
      };
    })
    .filter(Boolean);
}

function selectVariantCandidate(variant, candidates) {
  const profile = buildVariantProfile(variant);
  const scored = candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreVariantCandidate(candidate, profile)
    }))
    .filter((candidate) => candidate.score >= 5)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      if (left.unit && right.unit && left.unit !== right.unit) {
        return left.unit === profile.unit ? -1 : 1;
      }
      return right.value - left.value;
    });

  return scored[0] || null;
}

function buildVariantProfile(variant) {
  const options = variant?.options && typeof variant.options === "object" ? variant.options : {};
  const tokens = new Set();

  for (const value of [variant?.title, variant?.unit, ...Object.values(options)]) {
    const normalized = normalizeText(value);
    if (!normalized || normalized.length < 3) {
      continue;
    }

    tokens.add(normalized);
    for (const part of normalized.split(" ")) {
      if (part.length >= 3) {
        tokens.add(part);
      }
    }
  }

  return {
    unit: normalizeUnit(variant?.unit),
    tokens: [...tokens]
  };
}

function scoreVariantCandidate(candidate, profile) {
  const context = normalizeText(candidate.context);
  let score = 0;

  if (profile.unit && candidate.unit === profile.unit) {
    score += 5;
  }

  if (profile.unit && context.includes(profile.unit)) {
    score += 4;
  }

  for (const token of profile.tokens) {
    if (context.includes(token)) {
      score += token === profile.unit ? 0 : 1;
    }
  }

  if (candidate.source === "jsonld") {
    score += 2;
  } else if (candidate.source === "script-json") {
    score += 1;
  }

  if (candidate.currency === "RUB") {
    score += 4;
  }

  score += scoreAreaUnitValueFit(candidate.unit, candidate.value);

  return score;
}

function applyExtractedPricing(product, extracted) {
  let productChanged = false;
  let variantChanges = 0;
  const nextVariants = Array.isArray(product?.variants) ? [...product.variants] : [];

  for (const match of extracted.variantMatches) {
    const currentVariant = nextVariants[match.index];
    if (!currentVariant) {
      continue;
    }

    const nextPricing = normalizeSyncedPrice(match.priceValue, match.currency);
    const currentValue = Number(currentVariant.priceValue);
    const currentCurrency = normalizeCurrency(currentVariant.currency);
    const unitChanged = normalizeUnit(currentVariant.unit) !== normalizeUnit(match.unit);
    const currencyChanged = currentCurrency !== nextPricing.currency;
    if (currentValue === nextPricing.value && !unitChanged && !currencyChanged) {
      continue;
    }

    nextVariants[match.index] = {
      ...currentVariant,
      priceValue: nextPricing.value,
      price: formatPlainPrice(nextPricing.value),
      unit: match.unit || currentVariant.unit,
      currency: nextPricing.currency
    };
    variantChanges += 1;
  }

  if (variantChanges > 0) {
    product.variants = nextVariants;
    productChanged = true;
  }

  if (Number.isFinite(extracted.from) && extracted.from > 0) {
    const nextUnit = extracted.fromUnit || product?.unit || "";
    const normalizedPricing = normalizeSyncedPrice(extracted.from, extracted.fromCurrency || product?.pricing?.currency || "");
    const nextCurrency = normalizedPricing.currency;
    const priceFromChanged = Number(product?.priceFromValue) !== normalizedPricing.value;
    const unitChanged = normalizeUnit(product?.unit) !== normalizeUnit(nextUnit);
    const currencyChanged = normalizeCurrency(product?.pricing?.currency) !== normalizeCurrency(nextCurrency);

    if (priceFromChanged || unitChanged || currencyChanged) {
      product.priceFromValue = normalizedPricing.value;
      product.priceFrom = formatPrice(normalizedPricing.value, nextUnit, nextCurrency, {
        approximate: normalizedPricing.approximate
      });
      product.unit = nextUnit;
      product.pricing = {
        ...(product.pricing || {}),
        from: normalizedPricing.value,
        fromText: formatPrice(normalizedPricing.value, nextUnit, nextCurrency, {
          approximate: normalizedPricing.approximate
        }),
        unit: nextUnit,
        currency: nextCurrency,
        approximate: normalizedPricing.approximate
      };

      if (normalizedPricing.approximate) {
        product.pricing.sourceFrom = extracted.from;
        product.pricing.sourceCurrency = normalizeCurrency(extracted.fromCurrency);
        product.pricing.exchangeRate = usdToRubRate;
      } else {
        delete product.pricing.sourceFrom;
        delete product.pricing.sourceCurrency;
        delete product.pricing.exchangeRate;
      }

      productChanged = true;
    }
  }

  return { productChanged, variantChanges };
}

async function fetchText(url, timeout) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0 (compatible; OzelifPriceSync/1.0; +https://ozelifkoja.ru/)"
      },
      redirect: "follow",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    return response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function runWithConcurrency(items, limit) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const job = queue.shift();
      if (!job) {
        return;
      }

      await job();
    }
  });

  await Promise.all(workers);
}

function buildCatalogSummary(products) {
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
    .map((product) => Number(product?.priceFromValue))
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
  const variantLines = Array.isArray(product?.variants)
    ? product.variants.map((variant) =>
        [
          variant?.title,
          variant?.price,
          variant?.unit,
          ...Object.entries(variant?.options || {}).flatMap(([key, value]) => [key, value])
        ]
          .map(toText)
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
    product?.hideSize,
    product?.finish,
    product?.grade,
    product?.country,
    product?.minimumOrder,
    product?.priceFrom,
    product?.unit,
    ...variantLines
  ]
    .map(toText)
    .filter(Boolean)
    .join(". ");
}

function countValues(items) {
  const counts = new Map();

  for (const item of items.map(toText).filter(Boolean)) {
    const normalizedId = slugify(item);
    const current = counts.get(normalizedId) || { id: normalizedId, name: item, count: 0 };
    current.count += 1;
    counts.set(normalizedId, current);
  }

  return [...counts.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, "ru"));
}

function runEmbeddingsBuildIfConfigured(hasChanges) {
  if (!hasChanges) {
    return;
  }

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
    throw new Error("Prices synced, but embeddings build failed.");
  }
}

function formatChangeLog(product, changed) {
  const details = [];

  if (changed.productChanged) {
    details.push(`товар=${product.priceFrom}`);
  }

  if (changed.variantChanges) {
    details.push(`варианты=${changed.variantChanges}`);
  }

  return `OK ${product.name}: ${details.join(", ")}`;
}

function logDebugCandidates(product, extracted) {
  const debug = extracted?.debug;
  if (!debug) {
    return;
  }

  console.log("");
  console.log(`DEBUG ${product.name}`);
  console.log(`raw=${debug.rawCandidates.length}, sanitized=${debug.sanitizedCandidates.length}, filtered=${debug.filteredCandidates.length}, preferred=${debug.preferredCandidates.length}`);

  for (const [label, candidates] of [
    ["preferred", debug.preferredCandidates],
    ["filtered", debug.filteredCandidates.slice(0, 12)]
  ]) {
    for (const candidate of candidates.slice(0, 12)) {
      console.log(
        `  ${label}: value=${candidate.value} currency=${candidate.currency || "-"} explicit=${candidate.currencyExplicit ? "yes" : "no"} unit=${candidate.unit || "-"} source=${candidate.source} context=${truncateText(candidate.context, 140)}`
      );
    }
  }

  if (debug.productCandidate) {
    const candidate = debug.productCandidate;
    console.log(
      `  selected: value=${candidate.value} currency=${candidate.currency || "-"} explicit=${candidate.currencyExplicit ? "yes" : "no"} unit=${candidate.unit || "-"} source=${candidate.source} context=${truncateText(candidate.context, 140)}`
    );
  }
}

function dedupeCandidates(candidates) {
  const unique = new Map();

  for (const candidate of candidates) {
    const context = normalizeText(candidate.context).slice(0, 180);
    const currency = normalizeCurrency(candidate.currency);
    const key = `${candidate.source}:${candidate.value}:${candidate.unit || ""}:${currency}:${context}`;
    if (!unique.has(key)) {
      unique.set(key, {
        ...candidate,
        unit: normalizeUnit(candidate.unit),
        currency,
        currencyExplicit: Boolean(candidate.currencyExplicit),
        context
      });
    }
  }

  return [...unique.values()];
}

function extractJsonBlocks(content) {
  const blocks = [];
  const startChars = new Set(["{", "["]);

  for (let index = 0; index < content.length; index += 1) {
    const start = content[index];
    if (!startChars.has(start)) {
      continue;
    }

    const closing = start === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let cursor = index; cursor < content.length; cursor += 1) {
      const char = content[cursor];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === '"') {
        inString = !inString;
        continue;
      }

      if (inString) {
        continue;
      }

      if (char === start) {
        depth += 1;
      } else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          blocks.push(content.slice(index, cursor + 1));
          index = cursor;
          break;
        }
      }
    }
  }

  return blocks;
}

function safeJsonParse(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function stringifySnippet(value) {
  try {
    return JSON.stringify(value).slice(0, 500);
  } catch {
    return "";
  }
}

function inferUnitFromText(input) {
  const text = normalizeText(input);
  if (!text) {
    return "";
  }

  if (text.includes("дм2") || text.includes("дм 2") || text.includes("dm2")) {
    return "дм2";
  }

  if (
    text.includes("фут2") ||
    text.includes("фут 2") ||
    text.includes("fot") ||
    text.includes("ft2") ||
    text.includes("sqft")
  ) {
    return "фут2";
  }

  if (text.includes("м2") || text.includes("m2")) {
    return "м2";
  }

  return "";
}

function inferCurrencyFromText(input) {
  const text = String(input || "").toLowerCase();
  if (!text) {
    return "";
  }

  if (text.includes("pricecurrency") && text.includes("rub")) {
    return "RUB";
  }

  if (text.includes("₽") || text.includes("руб") || text.includes(" rub") || text.includes("\"rub\"")) {
    return "RUB";
  }

  return "";
}

function parseNumber(input) {
  const value = String(input || "")
    .replace(/\s+/g, "")
    .replace(",", ".");
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizePositiveNumber(input) {
  const parsed = parseNumber(input);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function firstFiniteNumber(...values) {
  for (const value of values) {
    const parsed = parseNumber(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

function normalizeInteger(input, fallback, limits = {}) {
  const parsed = Number.parseInt(input || "", 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  const min = Number.isFinite(limits.min) ? limits.min : value;
  const max = Number.isFinite(limits.max) ? limits.max : value;
  return Math.min(Math.max(value, min), max);
}

function formatPrice(price, unit, currency = "", options = {}) {
  return unit
    ? `от ${formatMoney(price, currency, options)} / ${unit}`
    : `от ${formatMoney(price, currency, options)}`;
}

function formatPlainPrice(price) {
  return Number.isInteger(price) ? String(price) : price.toFixed(2);
}

function formatMoney(price, currency, options = {}) {
  const formatted = formatPlainPrice(price);
  const prefix = options.approximate ? "~" : "";
  return normalizeCurrency(currency) === "RUB" ? `${prefix}${formatted} руб.` : `${prefix}${formatted}`;
}

function normalizeUnit(input) {
  const text = toText(input).toLowerCase();

  if (!text) {
    return "";
  }

  if (text === "fot" || text === "ft2" || text === "sqft" || text === "фут2" || text === "фут 2") {
    return "фут2";
  }

  if (text === "dm2" || text === "дм2" || text === "дм 2") {
    return "дм2";
  }

  return toText(input);
}

function normalizeCurrency(input) {
  const text = toText(input).toUpperCase();

  if (!text) {
    return "";
  }

  if (text === "RUB" || text === "RUR" || text === "РУБ" || text === "₽") {
    return "RUB";
  }

  return text;
}

function normalizeSyncedPrice(value, currency) {
  const normalizedCurrency = normalizeCurrency(currency);
  const normalizedValue = Number(value);

  if (!Number.isFinite(normalizedValue) || normalizedValue <= 0) {
    return {
      value,
      currency: normalizedCurrency,
      approximate: false
    };
  }

  if (normalizedCurrency === "RUB" || !usdToRubRate) {
    return {
      value: normalizedValue,
      currency: normalizedCurrency,
      approximate: false
    };
  }

  return {
    value: roundMoney(normalizedValue * usdToRubRate),
    currency: "RUB",
    approximate: true
  };
}

function roundMoney(value) {
  return value >= 100 ? Math.round(value) : Number(value.toFixed(2));
}

function preferCurrencyCandidates(candidates, preferredCurrency) {
  const normalizedCurrency = normalizeCurrency(preferredCurrency);
  if (!normalizedCurrency) {
    return candidates;
  }

  const explicitMatching = candidates.filter(
    (candidate) => normalizeCurrency(candidate.currency) === normalizedCurrency && candidate.currencyExplicit
  );
  if (explicitMatching.length) {
    return explicitMatching;
  }

  const matching = candidates.filter((candidate) => normalizeCurrency(candidate.currency) === normalizedCurrency);
  return matching.length ? matching : candidates;
}

function sanitizeCandidate(candidate, product) {
  const value = Number(candidate?.value);
  const unit = normalizeUnit(candidate?.unit);
  const context = normalizeText(candidate?.context);
  const currency = normalizeCurrency(candidate?.currency);
  const productUnit = normalizeUnit(product?.unit);
  const likelyAreaProduct = isAreaUnit(unit) || isAreaUnit(productUnit) || hasAreaMarker(context);

  if (
    currency === "RUB" &&
    value > 0 &&
    value < 10 &&
    likelyAreaProduct &&
    !hasExplicitRubNearNumber(candidate?.context, value)
  ) {
    return {
      ...candidate,
      currency: "",
      currencyExplicit: false
    };
  }

  return candidate;
}

function isSuspiciousRubCandidate(candidate) {
  const currency = normalizeCurrency(candidate?.currency);
  if (currency !== "RUB") {
    return false;
  }

  const unit = normalizeUnit(candidate?.unit);
  if (!unit) {
    return false;
  }

  const value = Number(candidate?.value);
  if (!Number.isFinite(value)) {
    return false;
  }

  // For this catalog, prices in RUB per area unit are expected to be whole-order
  // values like 320/480, not fractional coefficients like 0.32/0.48.
  return value < 10;
}

function hasExplicitRubNearNumber(context, value) {
  const text = String(context || "").toLowerCase();
  if (!text) {
    return false;
  }

  const escapedNumber = escapeRegExp(formatPlainPrice(value)).replace("\\.", "[.,]");
  const compactNumber = escapeRegExp(String(value)).replace("\\.", "[.,]");
  const patterns = [
    new RegExp(`${escapedNumber}\\s*(?:₽|руб(?:\\.|ля|лей)?|rub)`, "i"),
    new RegExp(`${compactNumber}\\s*(?:₽|руб(?:\\.|ля|лей)?|rub)`, "i"),
    new RegExp(`(?:₽|руб(?:\\.|ля|лей)?|rub)\\s*${escapedNumber}`, "i"),
    new RegExp(`(?:₽|руб(?:\\.|ля|лей)?|rub)\\s*${compactNumber}`, "i")
  ];

  return patterns.some((pattern) => pattern.test(text));
}

function hasAreaMarker(text) {
  const normalized = normalizeText(text);
  return Boolean(normalized) && inferUnitFromText(normalized) !== "";
}

function isAreaUnit(unit) {
  const normalized = normalizeUnit(unit);
  return normalized === "фут2" || normalized === "дм2" || normalized === "м2";
}

function scoreAreaUnitValueFit(unit, value) {
  const normalizedUnit = normalizeUnit(unit);
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return 0;
  }

  if (normalizedUnit === "фут2") {
    return numericValue >= 1 ? 4 : -8;
  }

  if (normalizedUnit === "дм2") {
    return numericValue < 1 ? 3 : -2;
  }

  return 0;
}

function truncateText(input, maxLength) {
  const text = toText(input).replace(/\s+/g, " ");
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength - 1)}…`;
}

function escapeRegExp(input) {
  return String(input || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeText(input) {
  return toText(input)
    .toLowerCase()
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/[^a-z0-9а-яё]+/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function toText(input) {
  return String(input || "").trim();
}

function slugify(input) {
  return toText(input)
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, "-")
    .replace(/^-+|-+$/g, "");
}

function getArgValue(flag) {
  const inline = process.argv.find((entry) => entry.startsWith(`${flag}=`));
  if (inline) {
    return inline.slice(flag.length + 1);
  }

  const index = process.argv.indexOf(flag);
  if (index >= 0 && process.argv[index + 1]) {
    return process.argv[index + 1];
  }

  return "";
}

async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf8");
  return JSON.parse(raw);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
