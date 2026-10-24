// Catalogue lookup for the support bot.
//
// "Do you have this in silver?", "how much is the cube chain?", "is the clover
// bracelet in stock?" — the answers live in Sanity, and a bot that cannot see
// them either answers vaguely or escalates a sales question. This finds the
// products a message is talking about and hands the model their real details —
// price, stock, colours, sizes, material, and the product URL so the reply can
// carry a link the customer can tap.
//
// Matching is deliberately plain text scoring, not embeddings: product names are
// short and distinctive ("Cube Chain", "Royal Clover Bracelet"), a customer's
// reference to one shares its words, and a wrong match costs nothing — the model
// is instructed to use only what actually answers the question and ignore the
// rest.

import { createClient } from "@sanity/client";

const client = createClient({
  projectId: process.env.NEXT_PUBLIC_SANITY_PROJECT_ID!,
  dataset: process.env.NEXT_PUBLIC_SANITY_DATASET ?? "production",
  apiVersion: "2024-01-01",
  useCdn: true,
});

type CatalogueProduct = {
  name: string;
  slug: { current: string };
  price: number;
  originalPrice?: number;
  inStock: boolean;
  category: string | null;
  colors?: Array<{ label: string }>;
  sizes?: Array<{ label: string; inStock?: boolean }>;
  materials?: Array<{ label: string }>;
};

// Cached per warm serverless instance. The catalogue changes rarely and a
// support reply must not pay a Sanity round trip per message when it can help it.
let cache: { at: number; products: CatalogueProduct[] } | null = null;
const CACHE_MS = 10 * 60 * 1000;

async function loadCatalogue(): Promise<CatalogueProduct[]> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.products;
  try {
    const products = await client.fetch<CatalogueProduct[]>(
      `*[_type == "product" && !(_id in path("drafts.**"))] {
        name, slug, price, originalPrice, inStock, category,
        colors[] { label }, sizes[] { label, inStock }, materials[] { label }
      }`,
    );
    cache = { at: Date.now(), products: products ?? [] };
    return cache.products;
  } catch {
    // A catalogue failure must never sink a reply — the bot just answers without
    // product details, the same as before this existed.
    return cache?.products ?? [];
  }
}

// Words that appear in nearly every product name or customer sentence and so
// identify nothing on their own.
const STOP = new Set([
  "the", "and", "for", "with", "this", "that", "you", "have", "your", "want",
  "buy", "price", "cost", "much", "how", "what", "about", "does", "can", "get",
  "gold", "silver", "black", "rose", // colour words match variants, not products
]);

const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((t) => t.length >= 3 && !STOP.has(t));

// A bare dimension — "2mm", "4mm", "18k" — describes a property, not a product.
// It is exactly as long and exactly as distinctive-looking as a real keyword,
// so it used to score like one: a photo established a silver snake chain
// bracelet, and two turns later "there is 2mm size only" — a comment on THAT
// bracelet's sizing — matched a wholly different "2mm Rope Chain Gold" and the
// model answered about the wrong product with a straight face. Sizes only mean
// anything once a product is already in view, which the message text alone can
// never establish, so they are dropped from the SEARCHED message's tokens here
// rather than tuned as a scoring weight. A product's own name keeps every token
// it has; only what the customer typed is filtered.
const GENERIC_SPEC = /^\d+(\.\d+)?(mm|cm|k|kt|mg|g|ml)$/;
const searchTokens = (s: string) => tokens(s).filter((t) => !GENERIC_SPEC.test(t));

/**
 * The products a message appears to be about, best match first.
 *
 * Scores a product by how many of the message's meaningful words appear in its
 * name, weighting distinctive words ("clover", "figaro") over the category nouns
 * ("chain", "bracelet") that every name shares. A category-noun-only match is
 * still returned — "do you have chains?" deserves chains — but ranked beneath
 * anything more specific.
 */
export function matchProducts<T extends { name: string }>(message: string, products: T[], k = 3): T[] {
  const msg = new Set(searchTokens(message));
  if (!msg.size) return [];

  const CATEGORY_NOUNS = new Set(["chain", "chains", "bracelet", "bracelets", "ring", "rings", "earring", "earrings", "pendant", "pendants", "necklace", "necklaces"]);

  return products
    .map((p) => {
      let score = 0;
      for (const t of tokens(p.name)) {
        if (msg.has(t)) score += CATEGORY_NOUNS.has(t) ? 1 : 3;
      }
      return { p, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.p);
}

function formatProduct(p: CatalogueProduct): string {
  const bits = [
    p.originalPrice && p.originalPrice > p.price
      ? `₹${p.price} (on sale, was ₹${p.originalPrice})`
      : `₹${p.price}`,
    p.inStock === false ? "OUT OF STOCK" : "in stock",
  ];
  const colors = (p.colors ?? []).map((c) => c.label).filter(Boolean);
  if (colors.length) bits.push(`colours: ${colors.join(", ")}`);
  const sizes = (p.sizes ?? []).filter((s) => s.label);
  if (sizes.length) {
    bits.push(`sizes: ${sizes.map((s) => `${s.label}${s.inStock === false ? " (out of stock)" : ""}`).join(", ")}`);
  }
  else bits.push("no size option");
  const materials = (p.materials ?? []).map((m) => m.label).filter(Boolean);
  if (materials.length) bits.push(`material: ${materials.join(", ")}`);
  return `${p.name}, ${bits.join(" · ")}, https://www.ajuki.in/products/${p.slug.current}`;
}

/** One line per matched product, ready for the model's context. Empty string
 *  when the message names nothing in the catalogue. */
export async function productContext(message: string): Promise<string> {
  const matches = matchProducts(message, await loadCatalogue());
  return matches.map(formatProduct).join("\n");
}

/**
 * The whole catalogue, compactly — for when there are no words to match on.
 *
 * A customer who sends a photo of a bracelet has given us nothing to score:
 * matchProducts reads the message text, and a picture has none. The model was
 * therefore shown an empty CATALOGUE MATCHES block while looking at a product we
 * very much sell, and filled the gap by reading the Instagram screenshot's audio
 * credit as a brand name — it told a customer their blue clover bracelet was
 * another label's and that we couldn't help, with "Royal Clover Bracelet - Blue
 * Stone" sitting in stock.
 *
 * Recognising jewellery by sight needs the shortlist to be every product, so
 * this hands over all of them. Roughly 5k tokens, which is why it is reserved
 * for messages carrying an image rather than added to every reply.
 */
export async function catalogueIndex(): Promise<string> {
  const products = await loadCatalogue();
  return products
    .map((p) =>
      [
        p.name,
        `₹${p.price}`,
        p.inStock === false ? "OUT OF STOCK" : "in stock",
        `https://www.ajuki.in/products/${p.slug.current}`,
      ].join(" | "),
    )
    .join("\n");
}
