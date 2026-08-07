import { query } from '../db/client.js';
import { rank, type Product } from './rank.js';

export async function search(term: string): Promise<string[]> {
  const rows = await query('SELECT sku, title FROM products');
  const products = rows as unknown as Product[];
  return rank(term, products).map((h) => h.sku);
}
