import { tokenize } from './tokenize.js';

export interface Product {
  sku: string;
  title: string;
}

export interface Hit {
  sku: string;
  score: number;
}

// Scores every product against the query. Exact SKU matches score the same as
// fuzzy ones today — task t-58cc03 fixes that on its branch.
export function rank(query: string, products: Product[]): Hit[] {
  const terms = tokenize(query);
  const hits: Hit[] = [];
  for (const product of products) {
    const haystack = tokenize(`${product.sku} ${product.title}`);
    const overlap = terms.filter((t) => haystack.includes(t)).length;
    if (overlap > 0) hits.push({ sku: product.sku, score: overlap });
  }
  return hits.sort((a, b) => b.score - a.score);
}
