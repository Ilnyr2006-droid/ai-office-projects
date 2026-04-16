import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import crypto from "crypto";
import db from "./database-sqlite.ts";
import type { CatalogProduct, LeadRecord } from "./chat-types.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "../data");
const knowledgeBasePath = path.join(dataDir, "knowledge-base.json");
const catalogPath = path.join(dataDir, "catalog.json");
const catalogEmbeddingsPath = path.join(dataDir, "catalog-embeddings.json");

export interface KnowledgeBase {
  company?: any;
  products?: CatalogProduct[];
  faq?: { question: string; answer: string }[];
  salesNotes?: string[];
}

export interface CatalogEmbeddings {
  generatedAt: string;
  model: string;
  dimensions: number;
  items: { id: string; embedding: number[] }[];
}

export interface CatalogData {
  sourceFile: string;
  importedAt: string;
  summary: {
    totalProducts: number;
    totalVariants: number;
    categoriesCount: number;
    colorsCount: number;
    minPrice: number | null;
    maxPrice: number | null;
  };
  filters: {
    categories: string[];
    colors: string[];
    applications: string[];
    materialTypes: string[];
    leatherTypes: string[];
    finishes: string[];
  };
  products: CatalogProduct[];
}

export async function getKnowledgeBase(): Promise<KnowledgeBase> {
  return readJsonFile<KnowledgeBase>(knowledgeBasePath, {
    company: {},
    products: [],
    faq: [],
    salesNotes: []
  });
}

export async function getKnowledgeContext(query = "", options: { queryEmbedding?: number[] } = {}) {
  const knowledgeBase = await getKnowledgeBase();
  const importedCatalog = await getCatalog();
  const catalogProducts = Array.isArray(importedCatalog?.products) ? importedCatalog.products : [];
  const products = catalogProducts.length
    ? catalogProducts
    : Array.isArray(knowledgeBase.products)
      ? knowledgeBase.products
      : [];
  const faq = Array.isArray(knowledgeBase.faq) ? knowledgeBase.faq : [];
  const salesNotes = Array.isArray(knowledgeBase.salesNotes) ? knowledgeBase.salesNotes : [];
  const embeddingIndex = options.queryEmbedding ? await getCatalogEmbeddings() : null;
  const queryProfile = buildQueryProfile(query);

  const relevantProducts = selectRelevantProducts(products, query, {
    queryProfile,
    queryEmbedding: options.queryEmbedding,
    embeddingIndex
  });

  const productLines = relevantProducts.map((product) => {
    const applications = listToText(product.applications);
    const colors = listToText(product.colors);
    const categories = listToText(product.categories);
    const variants = formatVariants((product as any).variants);
    const matchHints = formatMatchHints(product, queryProfile);
    const priceLine = formatProductPrice(product);

    return [
      `- ${safe(product.name)}`,
      matchHints ? `совпадение: ${matchHints}` : "",
      product.category ? `категория: ${safe(product.category)}` : "",
      categories ? `разделы: ${categories}` : "",
      product.description ? `описание: ${safe(product.description)}` : "",
      applications ? `назначение: ${applications}` : "",
      colors ? `цвета: ${colors}` : "",
      product.thickness ? `толщина: ${safe(product.thickness)}` : "",
      product.materialType ? `сырье: ${safe(product.materialType)}` : "",
      product.leatherType ? `тип кожи: ${safe(product.leatherType)}` : "",
      product.origin ? `происхождение: ${safe(product.origin)}` : "",
      product.minimumOrder ? `минимальный заказ: ${safe(product.minimumOrder)}` : "",
      priceLine ? `цена: ${priceLine}` : "",
      product.stock ? `наличие: ${safe(product.stock)}` : "",
      variants ? `варианты: ${variants}` : ""
    ]
      .filter(Boolean)
      .join(", ");
  });

  const faqLines = faq.slice(0, 20).map(
    (item) => `- ${safe(item.question)} Ответ: ${safe(item.answer)}`
  );

  const salesNotesLines = salesNotes.slice(0, 20).map((item) => `- ${safe(item)}`);
  const companyLines = formatCompanyContext(knowledgeBase.company);

  return {
    company: knowledgeBase.company || {},
    topProducts: relevantProducts.slice(0, 3).map((product) => mapContextProduct(product, queryProfile)),
    relevantProducts: relevantProducts.map((product) => mapContextProduct(product, queryProfile)),
    text: [
      companyLines.length ? `Информация о компании:\n${companyLines.join("\n")}` : "",
      productLines.length ? `Товары:\n${productLines.join("\n")}` : "",
      faqLines.length ? `FAQ:\n${faqLines.join("\n")}` : "",
      salesNotesLines.length ? `Подсказки по продажам:\n${salesNotesLines.join("\n")}` : ""
    ]
      .filter(Boolean)
      .join("\n\n")
  };
}

function mapContextProduct(product: CatalogProduct, queryProfile: QueryProfile) {
  const priceLine = formatProductPrice(product);

  return {
    name: safe(product.name),
    category: safe(product.category),
    colors: Array.isArray(product.colors) ? product.colors.map(safe).filter(Boolean) : [],
    applications: Array.isArray(product.applications)
      ? product.applications.map(safe).filter(Boolean)
      : [],
    thickness: safe(product.thickness),
    leatherType: safe(product.leatherType),
    materialType: safe(product.materialType),
    priceFrom: priceLine,
    photo: getPrimaryPhoto(product),
    photos: getProductPhotos(product),
    matchHints: formatMatchHints(product, queryProfile)
  };
}

function formatCompanyContext(company: any) {
  if (!company || typeof company !== "object") {
    return [];
  }

  const phones = Array.isArray(company.phones)
    ? company.phones
        .map((item: any) =>
          [safe(item?.role), safe(item?.name), safe(item?.phone)].filter(Boolean).join(": ")
        )
        .filter(Boolean)
    : [];

  const tags = Array.isArray(company.advantages) ? company.advantages.map(safe).filter(Boolean) : [];
  const regions = Array.isArray(company.regions) ? company.regions.map(safe).filter(Boolean) : [];
  const cooperation = Array.isArray(company.wholesale?.clientTypes)
    ? company.wholesale.clientTypes.map(safe).filter(Boolean)
    : [];
  const productionDirections = Array.isArray(company.production?.directions)
    ? company.production.directions.map(safe).filter(Boolean)
    : [];
  const productionRules = Array.isArray(company.production?.requirements)
    ? company.production.requirements.map(safe).filter(Boolean)
    : [];

  return [
    company.name ? `- Компания: ${safe(company.name)}` : "",
    company.description ? `- Описание: ${safe(company.description)}` : "",
    tags.length ? `- Преимущества: ${tags.join(", ")}` : "",
    company.customOrders ? `- Кожа под заказ: ${safe(company.customOrders)}` : "",
    company.address ? `- Самовывоз: ${safe(company.address)}` : "",
    company.delivery ? `- Доставка: ${safe(company.delivery)}` : "",
    company.payment ? `- Оплата: ${safe(company.payment)}` : "",
    regions.length ? `- География: ${regions.join(", ")}` : "",
    phones.length ? `- Контакты: ${phones.join(" | ")}` : "",
    company.wholesale?.summary ? `- Опт: ${safe(company.wholesale.summary)}` : "",
    cooperation.length ? `- Для кого опт: ${cooperation.join(", ")}` : "",
    company.customLeather?.summary ? `- Кожа по образцу: ${safe(company.customLeather.summary)}` : "",
    company.production?.summary ? `- Швейное производство: ${safe(company.production.summary)}` : "",
    productionDirections.length ? `- Направления производства: ${productionDirections.join(", ")}` : "",
    company.production?.minimumOrder
      ? `- Минимальный заказ на производство: ${safe(company.production.minimumOrder)}`
      : "",
    company.production?.capacity ? `- Мощность производства: ${safe(company.production.capacity)}` : "",
    company.production?.sampleTimeline
      ? `- Срок пошива образца: ${safe(company.production.sampleTimeline)}`
      : "",
    company.production?.productionTimeline
      ? `- Срок серийного производства: ${safe(company.production.productionTimeline)}`
      : "",
    productionRules.length ? `- Условия производства: ${productionRules.join("; ")}` : "",
    company.production?.confidentiality
      ? `- Конфиденциальность: ${safe(company.production.confidentiality)}`
      : ""
  ].filter(Boolean);
}

export async function getCatalog(): Promise<CatalogData> {
  return readJsonFile<CatalogData>(catalogPath, {
    sourceFile: "",
    importedAt: "",
    summary: {
      totalProducts: 0,
      totalVariants: 0,
      categoriesCount: 0,
      colorsCount: 0,
      minPrice: null,
      maxPrice: null
    },
    filters: {
      categories: [],
      colors: [],
      applications: [],
      materialTypes: [],
      leatherTypes: [],
      finishes: []
    },
    products: []
  });
}

export async function searchCatalog(query = "", limit = 24) {
  const catalog = await getCatalog();
  const products = Array.isArray(catalog.products) ? catalog.products : [];
  const normalizedLimit = Math.max(1, Math.min(Number(limit) || 24, 100));
  const queryProfile = buildQueryProfile(query);

  return {
    ...catalog,
    products: selectRelevantProducts(products, query, { queryProfile }).slice(0, normalizedLimit)
  };
}

export async function getCatalogEmbeddings(): Promise<CatalogEmbeddings> {
  return readJsonFile<CatalogEmbeddings>(catalogEmbeddingsPath, {
    generatedAt: "",
    model: "",
    dimensions: 0,
    items: []
  });
}

export async function saveLead(lead: Partial<LeadRecord>) {
  const storedLead: LeadRecord = {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    ...lead
  };

  const { id, createdAt, name, phone, contact, interest, notes, transcript, source, ...otherData } = storedLead;

  db.prepare(`
    INSERT INTO leads (id, created_at, name, phone, contact, interest, notes, transcript, source, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    createdAt,
    name || null,
    phone || null,
    contact || null,
    interest || null,
    notes || null,
    transcript || null,
    source || null,
    JSON.stringify(otherData)
  );

  return storedLead;
}

export async function getLeads(): Promise<LeadRecord[]> {
  const rows = db.prepare("SELECT * FROM leads ORDER BY created_at DESC").all() as any[];
  return rows.map(row => {
    const { data, ...base } = row;
    try {
      const otherData = JSON.parse(data || "{}");
      return {
        ...base,
        ...otherData,
        createdAt: row.created_at
      };
    } catch (e) {
      return base;
    }
  });
}

async function readJsonFile<T>(filePath: string, fallback: T): Promise<T> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return fallback;
    }

    throw error;
  }
}

function listToText(value: any) {
  return Array.isArray(value) ? value.map(safe).filter(Boolean).join(", ") : "";
}

function formatVariants(variants: any[]) {
  if (!Array.isArray(variants) || variants.length === 0) {
    return "";
  }

  return variants
    .slice(0, 4)
    .map((variant) => {
      const options = variant?.options
        ? Object.entries(variant.options)
            .map(([key, value]) => `${safe(key)}: ${safe(value)}`)
            .filter(Boolean)
            .join(", ")
        : "";
      const variantPrice = formatVariantPrice(variant);

      return [safe(variant?.title), variantPrice, options].filter(Boolean).join(" | ");
    })
    .filter(Boolean)
    .join(" ; ");
}

function formatProductPrice(product: CatalogProduct) {
  const pricing = (product as any)?.pricing && typeof (product as any).pricing === "object" ? (product as any).pricing : null;
  const value = Number(pricing?.from ?? (product as any)?.priceFromValue);
  const currency = safe(pricing?.currency);
  const unit = safe(pricing?.unit || (product as any)?.unit);
  const approximate = Boolean(pricing?.approximate);

  if (Number.isFinite(value) && value > 0) {
    return formatPriceSummary(value, unit, currency, { approximate, prefix: "от " });
  }

  return safe(pricing?.fromText || (product as any)?.priceFrom);
}

function formatVariantPrice(variant: any) {
  const value = Number(variant?.priceValue ?? variant?.price);
  const currency = safe(variant?.currency);
  const unit = safe(variant?.unit);

  if (Number.isFinite(value) && value > 0) {
    return formatPriceSummary(value, unit, currency);
  }

  return [safe(variant?.price), unit].filter(Boolean).join(" / ");
}

function formatPriceSummary(value: number, unit: string, currency: string, options: any = {}) {
  const prefix = typeof options?.prefix === "string" ? options.prefix : "";
  const approximateMarker = options?.approximate ? "~" : "";
  const amount = Number.isInteger(value) ? String(value) : value.toFixed(2);
  const money = normalizeCurrency(currency) === "RUB" ? `${approximateMarker}${amount} руб.` : `${approximateMarker}${amount}`;
  return unit ? `${prefix}${money} / ${unit}` : `${prefix}${money}`;
}

function getPrimaryPhoto(product: CatalogProduct) {
  const mediaPhoto = Array.isArray(product?.media)
    ? product.media.find((item) => safe(item?.type).toLowerCase() === "image" && safe(item?.url))
    : null;

  return safe(mediaPhoto?.url || product?.photo || getProductPhotos(product)[0]);
}

function getProductPhotos(product: CatalogProduct) {
  const directPhotos = Array.isArray(product?.photos) ? product.photos : [];
  const mediaPhotos = Array.isArray(product?.media)
    ? product.media
        .filter((item) => safe(item?.type).toLowerCase() === "image" && safe(item?.url))
        .map((item) => item.url)
    : [];

  return [...new Set([...directPhotos, ...mediaPhotos].map(safe).filter(Boolean))];
}

function normalizeCurrency(input: string) {
  const value = safe(input).toUpperCase();

  if (!value) {
    return "";
  }

  if (value === "RUB" || value === "RUR" || value === "РУБ" || value === "₽") {
    return "RUB";
  }

  return value;
}

interface SearchOptions {
  queryProfile?: QueryProfile;
  queryEmbedding?: number[];
  embeddingIndex?: CatalogEmbeddings | null;
}

function selectRelevantProducts(products: CatalogProduct[], query: string, options: SearchOptions = {}): CatalogProduct[] {
  if (!Array.isArray(products) || products.length === 0) {
    return [];
  }

  const queryProfile = options.queryProfile || buildQueryProfile(query);
  const { tokens } = queryProfile;

  if (tokens.length === 0) {
    return products.slice(0, 20);
  }

  const vectorMap = buildEmbeddingMap(options.embeddingIndex);

  return products
    .map((product) => ({
      product,
      score: scoreProduct(product, queryProfile, options.queryEmbedding, vectorMap)
    }))
    .filter((item) => item.score > 0.15)
    .sort((left, right) => right.score - left.score)
    .slice(0, 20)
    .map((item) => item.product);
}

function scoreProduct(product: CatalogProduct, queryProfile: QueryProfile, queryEmbedding: number[] | undefined, vectorMap: Map<string, number[]>) {
  const { tokens, normalizedQuery } = queryProfile;
  const haystack = buildSearchableText(product);
  const exactAttributes = collectProductAttributes(product);
  const intentText = buildIntentText(product);
  const productDomains = detectProductDomains(product);
  const productLeatherTypes = normalizeValues([product.leatherType]);
  const productMaterials = normalizeValues([product.materialType]);
  const productColors = normalizeValues(product.colors);
  const productApplications = normalizeValues(product.applications);

  let score = 0;

  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 1.4;
    }
  }

  if (product.name && normalizedQuery.includes(safe(product.name).toLowerCase())) {
      score += 4;
  }

  for (const entry of exactAttributes) {
    if (normalizedQuery.includes(entry)) {
      score += 1.8;
    }
  }

  const thickness = safe((product as any).attributes?.thicknessMm || product.thickness).toLowerCase();
  if (thickness && normalizedQuery.includes(thickness.replace(/\s*мм$/, ""))) {
    score += 1;
  }

  score += scoreIntentAlignment(intentText, queryProfile);
  score += scoreProductTypeAlignment(intentText, queryProfile);
  score += scoreDomainAlignment(productDomains, queryProfile);
  score += scoreAttributeAlignment(
    {
      colors: productColors,
      applications: productApplications,
      leatherTypes: productLeatherTypes,
      materials: productMaterials
    },
    queryProfile
  );

  if (queryEmbedding && vectorMap.size > 0) {
    const vector = vectorMap.get(safe((product as any).id));
    if (Array.isArray(vector) && vector.length === queryEmbedding.length) {
      score += cosineSimilarity(queryEmbedding, vector) * 8;
    }
  }

  return score;
}

function buildEmbeddingMap(embeddingIndex: CatalogEmbeddings | null | undefined): Map<string, number[]> {
  const items = Array.isArray(embeddingIndex?.items) ? embeddingIndex!.items : [];
  return new Map(
    items
      .filter((item) => safe(item.id) && Array.isArray(item.embedding) && item.embedding.length > 0)
      .map((item) => [safe(item.id), item.embedding])
  );
}

function buildSearchableText(product: CatalogProduct) {
  if ((product as any)?.searchText) {
    return safe((product as any).searchText).toLowerCase();
  }

  return [
    product.name,
    product.category,
    ...(Array.isArray((product as any).categories) ? (product as any).categories : []),
    product.description,
    (product as any).shortDescription,
    ...(Array.isArray(product.applications) ? product.applications : []),
    ...(Array.isArray(product.colors) ? product.colors : []),
    product.thickness,
    product.materialType,
    product.leatherType,
    product.origin,
    (product as any).finish,
    product.minimumOrder,
    (product as any).priceFrom
  ]
    .map((item) => safe(item).toLowerCase())
    .filter(Boolean)
    .join(" | ");
}

function collectProductAttributes(product: CatalogProduct) {
  return [
    product.category,
    ...(Array.isArray((product as any).categories) ? (product as any).categories : []),
    ...(Array.isArray(product.applications) ? product.applications : []),
    ...(Array.isArray(product.colors) ? product.colors : []),
    product.materialType,
    product.leatherType,
    product.origin,
    (product as any).finish
  ]
    .map((item) => safe(item).toLowerCase())
    .filter(Boolean);
}

function buildIntentText(product: CatalogProduct) {
  return [
    product.name,
    product.category,
    ...(Array.isArray((product as any).categories) ? (product as any).categories : []),
    ...(Array.isArray(product.applications) ? product.applications : []),
    ...(Array.isArray((product as any).categoryPath) ? (product as any).categoryPath : []),
    product.leatherType,
    product.materialType
  ]
    .map((item) => safe(item).toLowerCase())
    .filter(Boolean)
    .join(" | ");
}

interface QueryProfile {
  normalizedQuery: string;
  tokens: string[];
  colors: string[];
  applications: string[];
  leatherTypes: string[];
  materials: string[];
  thickness: string[];
  intents: any[];
  domains: string[];
  wantsMaterial: boolean;
  wantsHardware: boolean;
}

function buildQueryProfile(query: string): QueryProfile {
  const normalizedQuery = safe(query).toLowerCase();
  const tokens = tokenize(normalizedQuery);
  const intentRules = extractIntentRules(normalizedQuery, tokens);

  return {
    normalizedQuery,
    tokens,
    colors: extractMatchingTerms(normalizedQuery, tokens, COLOR_TERMS),
    applications: extractMatchingTerms(normalizedQuery, tokens, APPLICATION_TERMS),
    leatherTypes: extractMatchingTerms(normalizedQuery, tokens, LEATHER_TYPE_TERMS),
    materials: extractMatchingTerms(normalizedQuery, tokens, MATERIAL_TYPE_TERMS),
    thickness: extractThicknessHints(normalizedQuery),
    intents: intentRules,
    domains: extractQueryDomains(normalizedQuery, tokens, intentRules),
    wantsMaterial: hasAnyMatch(normalizedQuery, tokens, MATERIAL_QUERY_TERMS),
    wantsHardware: hasAnyMatch(normalizedQuery, tokens, HARDWARE_QUERY_TERMS)
  };
}

function extractIntentRules(normalizedQuery: string, tokens: string[]) {
  return QUERY_INTENT_RULES.filter((rule) =>
    rule.terms.some((term) => normalizedQuery.includes(term) || tokens.includes(term))
  );
}

function hasAnyMatch(normalizedQuery: string, tokens: string[], terms: string[]) {
  return terms.some((term) => normalizedQuery.includes(term) || tokens.includes(term));
}

function scoreIntentAlignment(intentText: string, queryProfile: QueryProfile) {
  const intents = Array.isArray(queryProfile?.intents) ? queryProfile.intents : [];

  if (!intentText || intents.length === 0) {
    return 0;
  }

  let score = 0;

  for (const intent of intents) {
    if (intent.preferred.some((term: string) => intentText.includes(term))) {
      score += 4.5;
    }

    if (intent.secondary.some((term: string) => intentText.includes(term))) {
      score += 1.5;
    }

    if (intent.discouraged.some((term: string) => intentText.includes(term))) {
      score -= 4;
    }
  }

  return score;
}

function scoreProductTypeAlignment(intentText: string, queryProfile: QueryProfile) {
  if (!intentText) {
    return 0;
  }

  if (queryProfile?.wantsHardware) {
    return intentText.includes("фурнитур") ? 4 : -1.5;
  }

  if (queryProfile?.wantsMaterial && intentText.includes("фурнитур")) {
    return -6;
  }

  return 0;
}

function scoreDomainAlignment(productDomains: string[], queryProfile: QueryProfile) {
  const requestedDomains = Array.isArray(queryProfile?.domains) ? queryProfile.domains : [];

  if (requestedDomains.length === 0) {
    return 0;
  }

  let score = 0;

  for (const domain of requestedDomains) {
    if (productDomains.includes(domain)) {
      score += DOMAIN_MATCH_SCORES[domain as keyof typeof DOMAIN_MATCH_SCORES] || 5;
      continue;
    }

    for (const conflictingDomain of DOMAIN_CONFLICTS[domain as keyof typeof DOMAIN_CONFLICTS] || []) {
      if (productDomains.includes(conflictingDomain)) {
        score -= DOMAIN_MISMATCH_SCORES[domain as keyof typeof DOMAIN_MISMATCH_SCORES] || 6;
      }
    }
  }

  if (!requestedDomains.includes("shearling") && productDomains.includes("shearling")) {
    score -= requestedDomains.includes("apparel") ? 4.5 : 2.5;
  }

  return score;
}

function scoreAttributeAlignment(productAttributes: any, queryProfile: QueryProfile) {
  let score = 0;

  if (queryProfile.colors.length > 0) {
    score += hasIntersection(productAttributes.colors, queryProfile.colors) ? 3.5 : -1.5;
  }

  if (queryProfile.applications.length > 0) {
    score += hasIntersection(productAttributes.applications, queryProfile.applications) ? 4.5 : -2.5;
  }

  if (queryProfile.leatherTypes.length > 0) {
    if (hasIntersection(productAttributes.leatherTypes, queryProfile.leatherTypes)) {
      score += 6;
    } else if (productAttributes.leatherTypes.length > 0) {
      score -= 3.5;
    }
  }

  if (queryProfile.materials.length > 0) {
    score += hasIntersection(productAttributes.materials, queryProfile.materials) ? 2.5 : -1;
  }

  return score;
}

function formatMatchHints(product: CatalogProduct, queryProfile: QueryProfile) {
  if (!queryProfile || queryProfile.tokens.length === 0) {
    return "";
  }

  const hints = [];
  const productColors = normalizeValues(product.colors);
  const productApplications = normalizeValues(product.applications);
  const productLeatherType = normalizeValues([product.leatherType]);
  const productMaterialType = normalizeValues([product.materialType]);
  const thickness = safe((product as any).attributes?.thicknessMm || product.thickness).toLowerCase();

  if (queryProfile.colors.length > 0 && hasIntersection(productColors, queryProfile.colors)) {
    hints.push(`цвет ${listMatchValues(productColors, queryProfile.colors)}`);
  }

  if (
    queryProfile.applications.length > 0 &&
    hasIntersection(productApplications, queryProfile.applications)
  ) {
    hints.push(`назначение ${listMatchValues(productApplications, queryProfile.applications)}`);
  }

  if (
    queryProfile.leatherTypes.length > 0 &&
    hasIntersection(productLeatherType, queryProfile.leatherTypes)
  ) {
    hints.push(`тип ${listMatchValues(productLeatherType, queryProfile.leatherTypes)}`);
  }

  if (queryProfile.materials.length > 0 && hasIntersection(productMaterialType, queryProfile.materials)) {
    hints.push(`сырье ${listMatchValues(productMaterialType, queryProfile.materials)}`);
  }

  if (queryProfile.thickness.length > 0 && thickness) {
    for (const thicknessHint of queryProfile.thickness) {
      if (thickness.includes(thicknessHint)) {
        hints.push(`толщина ${safe(product.thickness)}`);
        break;
      }
    }
  }

  return hints.join(", ");
}

function normalizeValues(values: any) {
  return (Array.isArray(values) ? values : [])
    .map((value) => safe(value).toLowerCase())
    .filter(Boolean);
}

function extractMatchingTerms(normalizedQuery: string, tokens: string[], dictionary: string[]) {
  return dictionary.filter((term) => normalizedQuery.includes(term) || tokens.includes(term));
}

function extractThicknessHints(normalizedQuery: string) {
  const matches = normalizedQuery.match(/\d+(?:[.,]\d+)?(?:\s*-\s*\d+(?:[.,]\d+)?)?/g) || [];
  return matches.map((item) => item.replace(/\s+/g, "").replace(",", "."));
}

function extractQueryDomains(normalizedQuery: string, tokens: string[], intents: any[]) {
  const domains = new Set<string>();

  for (const [domain, terms] of Object.entries(DOMAIN_QUERY_TERMS)) {
    if (terms.some((term) => normalizedQuery.includes(term) || tokens.includes(term))) {
      domains.add(domain);
    }
  }

  for (const intent of Array.isArray(intents) ? intents : []) {
    for (const domain of intent.domains || []) {
      domains.add(domain);
    }
  }

  return [...domains];
}

function detectProductDomains(product: CatalogProduct) {
  const text = [
    product.name,
    product.category,
    ...(Array.isArray((product as any).categories) ? (product as any).categories : []),
    ...(Array.isArray(product.applications) ? product.applications : []),
    ...(Array.isArray((product as any).categoryPath) ? (product as any).categoryPath.map((item: any) => item?.name) : []),
    product.leatherType,
    product.materialType,
    product.description,
    (product as any).searchText
  ]
    .map((item) => safe(item).toLowerCase())
    .filter(Boolean)
    .join(" | ");

  const domains = new Set<string>();

  for (const [domain, terms] of Object.entries(DOMAIN_PRODUCT_TERMS)) {
    if (terms.some((term) => text.includes(term))) {
      domains.add(domain);
    }
  }

  return [...domains];
}

function hasIntersection(left: string[], right: string[]) {
  return left.some((value) => right.includes(value));
}

function listMatchValues(productValues: string[], queryValues: string[]) {
  return productValues.filter((value) => queryValues.includes(value)).join(", ");
}

const COLOR_TERMS = [
  "черный",
  "чёрный",
  "коричневый",
  "бежевый",
  "серый",
  "белый",
  "синий",
  "красный",
  "зеленый",
  "зелёный"
];

const APPLICATION_TERMS = [
  "куртка",
  "куртки",
  "одежда",
  "одежный",
  "одежная",
  "сумка",
  "сумки",
  "обувь",
  "обуви",
  "галантерея",
  "галантерейный",
  "галантерейная"
];

const LEATHER_TYPE_TERMS = [
  "замша",
  "наппа",
  "велюр",
  "крейзи хорс",
  "crazy horse",
  "флотер",
  "шевро",
  "дубленочный",
  "дубленочная"
];

const MATERIAL_TYPE_TERMS = ["овчина", "коза", "теленок", "телячья", "крс"];
const MATERIAL_QUERY_TERMS = ["кожа", "замша", "дубленка", "дубленки", "дубленочная", "материал"];
const HARDWARE_QUERY_TERMS = ["фурнитура", "молния", "молнии", "кнопка", "кнопки", "замок", "карабины"];

const QUERY_INTENT_RULES = [
  {
    terms: ["сумка", "сумки", "сумок", "рюкзак", "рюкзака", "кошелек", "кошелек", "галантерея"],
    domains: ["bags"],
    preferred: ["галантер"],
    secondary: ["фурнитур"],
    discouraged: ["одежн", "дублен", "обувн"]
  },
  {
    terms: ["обувь", "обуви", "ботинок", "ботинки", "туфли", "кроссовки"],
    domains: ["shoes"],
    preferred: ["обувн"],
    secondary: [],
    discouraged: ["одежн", "дублен", "галантер"]
  },
  {
    terms: ["куртка", "куртки", "одежда", "одежный", "одежная", "плащ"],
    domains: ["apparel"],
    preferred: ["одежн"],
    secondary: [],
    discouraged: ["галантер", "обувн"]
  },
  {
    terms: ["дубленка", "дубленки", "дубленочная", "дубленочный"],
    domains: ["shearling", "apparel"],
    preferred: ["дублен"],
    secondary: ["одежн"],
    discouraged: ["галантер", "обувн"]
  }
];

const DOMAIN_QUERY_TERMS = {
  bags: ["сумка", "сумки", "сумок", "рюкзак", "рюкзака", "кошелек", "кошелёк", "галантерея"],
  shoes: ["обувь", "обуви", "ботинок", "ботинки", "туфли", "кроссовки"],
  apparel: ["куртка", "куртки", "одежда", "одежный", "одежная", "плащ"],
  shearling: ["дубленка", "дубленки", "дубленочная", "дубленочный"],
  hardware: ["фурнитура", "молния", "молнии", "кнопка", "кнопки", "замок", "карабины"]
};

const DOMAIN_PRODUCT_TERMS = {
  bags: ["галантер", "сум", "рюкзак", "кошел"],
  shoes: ["обувн", "ботин", "туф", "кроссов"],
  apparel: ["одежн", "куртк", "плащ"],
  shearling: ["дублен", "керли", "меринилл", "меринос", "изланда", "тоскана", "тиградо"],
  hardware: ["фурнитур", "молни", "кноп", "замок", "карабин", "ykk"]
};

const DOMAIN_MATCH_SCORES = {
  bags: 8,
  shoes: 8,
  apparel: 7,
  shearling: 9,
  hardware: 10
};

const DOMAIN_MISMATCH_SCORES = {
  bags: 7,
  shoes: 7,
  apparel: 6,
  shearling: 7,
  hardware: 10
};

const DOMAIN_CONFLICTS = {
  bags: ["apparel", "shearling", "shoes"],
  shoes: ["apparel", "shearling", "bags"],
  apparel: ["bags", "shoes", "hardware"],
  shearling: ["bags", "shoes", "hardware"],
  hardware: ["bags", "shoes", "apparel", "shearling"]
};

function tokenize(input: string) {
  const synonyms: Record<string, string[]> = {
    куртка: ["одежная", "для одежды", "кожа для курток"],
    одежда: ["одежная", "для одежды"],
    обувь: ["обувная", "для обуви"],
    сумка: ["для сумок", "галантерейная"],
    мягкая: ["мягкая", "пластичная", "одежная"],
    замша: ["замша", "suede"],
    коричневая: ["коричневый", "brown"],
    черная: ["черный", "black"],
    белая: ["белый", "white"],
    синяя: ["синий", "blue"],
    красная: ["красный", "red"]
  };

  const baseTokens = safe(input)
    .split(/[^a-z0-9а-яё]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  const expanded = new Set(baseTokens);

  for (const token of baseTokens) {
    const normalizedToken = token.toLowerCase();
    for (const [key, values] of Object.entries(synonyms)) {
      if (normalizedToken === key || normalizedToken.startsWith(key.slice(0, Math.max(3, key.length - 2)))) {
        for (const value of values) {
          expanded.add(value.toLowerCase());
        }
      }
    }
  }

  return [...expanded];
}

function cosineSimilarity(left: number[], right: number[]) {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = Number(left[index]) || 0;
    const rightValue = Number(right[index]) || 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}

function safe(value: any) {
  return String(value || "").trim();
}
