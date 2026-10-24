const GEMINI_CONFIG = {
  MODEL: 'gemini-3.6-flash',
  API_BASE: 'https://generativelanguage.googleapis.com/v1beta/models/',
  MAX_ATTEMPTS: 3,
  RETRY_DELAY_MS: 2000,
  MATCH_THRESHOLD: 0.8,
  BATCH_SIZE: 25,
  FULL_CATALOG_LIMIT: 10000,
  CANDIDATES_PER_ITEM: 10,
  ALIAS_LIMIT: 500
};

const MATCH_CONFIG = {
  THRESHOLD: 0.8,
  SUGGESTION_THRESHOLD: 0.3,
  AMBIGUITY_MARGIN: 0.05,
  MAX_SUGGESTIONS: 10,
  MIN_CANDIDATES: 12,
  MAX_CANDIDATES: 250,
  ALIAS_LEARN_CONFIDENCE: 0.9
};

const RECEIPT_TOKEN_ALIASES = {
  bks: 'bungkus',
  bngks: 'bungkus',
  bngkus: 'bungkus',
  btl: 'botol',
  btg: 'batang',
  dus: 'dus',
  dos: 'dus',
  g: 'g',
  gr: 'g',
  gram: 'g',
  grm: 'g',
  kg: 'kg',
  kilo: 'kg',
  kilogram: 'kg',
  klg: 'kaleng',
  krt: 'karton',
  krat: 'karton',
  karton: 'karton',
  l: 'l',
  liter: 'l',
  ltr: 'l',
  mi: 'mie',
  mie: 'mie',
  ml: 'ml',
  mili: 'ml',
  pc: 'pcs',
  pcs: 'pcs',
  buah: 'pcs',
  biji: 'pcs',
  pak: 'pack',
  pck: 'pack',
  pk: 'pack',
  pack: 'pack',
  rcg: 'renceng',
  renceng: 'renceng',
  sct: 'sachet',
  sachet: 'sachet',
  x: 'x'
};

const RECEIPT_NOISE_TOKENS = new Set([
  'bungkus',
  'botol',
  'batang',
  'dus',
  'g',
  'kg',
  'kaleng',
  'karton',
  'l',
  'ml',
  'pcs',
  'pack',
  'renceng',
  'sachet',
  'x',
  'isi',
  'per'
]);

const SHEET_CONFIG = {
  INVENTORY: {
    NAME: 'Inventory Master',
    PRODUCT_COL: 1,
    QTY_COL: 2,
    UNIT_COL: 3
  },
  SCAN_LOG: {
    NAME: 'Scan Log',
    HEADERS: ['Timestamp', 'Scanned Product', 'Quantity', 'Unit', 'Resolved Product', 'Confidence', 'Status']
  },
  ALIAS: {
    NAME: 'Product Aliases',
    HEADERS: ['Alias', 'Canonical Product']
  }
};
