let productListMemo = null;
let aliasMemo = null;

function getInventorySheet() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet()
    .getSheetByName(SHEET_CONFIG.INVENTORY.NAME);
  if (!sheet) {
    throw new Error(
      `Sheet "${SHEET_CONFIG.INVENTORY.NAME}" not found. ` +
      'Create it with headers: Product | Quantity | Unit.'
    );
  }
  return sheet;
}

function getUserProductList({ forceRefresh = false, sheet } = {}) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const spreadsheetId = spreadsheet.getId();

  if (!forceRefresh && productListMemo && productListMemo.spreadsheetId === spreadsheetId) {
    return productListMemo.names.slice();
  }

  const inventorySheet = sheet || getInventorySheet();
  const lastRow = inventorySheet.getLastRow();
  const names = [];

  if (lastRow >= 2) {
    const values = inventorySheet
      .getRange(2, SHEET_CONFIG.INVENTORY.PRODUCT_COL, lastRow - 1, 1)
      .getValues();
    const seen = new Set();

    for (const [value] of values) {
      const name = String(value == null ? '' : value).trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }
  }

  productListMemo = { spreadsheetId, names };
  return names.slice();
}

function getProductAliases({ forceRefresh = false, sheet } = {}) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  const spreadsheetId = spreadsheet.getId();

  if (!forceRefresh && aliasMemo && aliasMemo.spreadsheetId === spreadsheetId) {
    return new Map(aliasMemo.aliases);
  }

  const aliasSheet = sheet || spreadsheet.getSheetByName(SHEET_CONFIG.ALIAS.NAME);
  const aliases = new Map();

  if (aliasSheet && aliasSheet.getLastRow() >= 2) {
    const values = aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, 2).getValues();

    for (const [aliasValue, canonicalValue] of values) {
      const aliasKey = normalizeProductName(aliasValue);
      const canonical = String(canonicalValue == null ? '' : canonicalValue).trim();
      if (!aliasKey || !canonical || aliases.has(aliasKey)) continue;
      aliases.set(aliasKey, canonical);
    }
  }

  aliasMemo = { spreadsheetId, aliases };
  return new Map(aliases);
}

function appendProductAliases(aliasPairs) {
  if (!aliasPairs || !aliasPairs.length) return 0;

  const existing = getProductAliases();
  const pending = new Set();
  const rows = [];

  for (const [alias, canonicalValue] of aliasPairs) {
    const aliasKey = normalizeProductName(alias);
    const canonical = String(canonicalValue == null ? '' : canonicalValue).trim();
    if (!aliasKey || !canonical || existing.has(aliasKey) || pending.has(aliasKey)) continue;

    pending.add(aliasKey);
    rows.push([String(alias).trim(), canonical]);
  }

  if (!rows.length) return 0;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_CONFIG.ALIAS.NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_CONFIG.ALIAS.NAME);
    sheet.appendRow(SHEET_CONFIG.ALIAS.HEADERS);
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
  aliasMemo = null;
  return rows.length;
}

function appendInventoryRows(rows) {
  if (!rows.length) return;

  const sheet = getInventorySheet();
  sheet.getRange(
    sheet.getLastRow() + 1,
    SHEET_CONFIG.INVENTORY.PRODUCT_COL,
    rows.length,
    SHEET_CONFIG.INVENTORY.UNIT_COL
  ).setValues(rows);
  productListMemo = null;
}

function updateInventoryStock(items) {
  const matched = items.filter(item => item.status === 'matched');
  if (!matched.length) return;

  const sheet = getInventorySheet();
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  const data = sheet.getRange(2, 1, lastRow - 1, SHEET_CONFIG.INVENTORY.UNIT_COL).getValues();
  const rowIndexByName = new Map();

  data.forEach((row, index) => {
    const name = String(row[SHEET_CONFIG.INVENTORY.PRODUCT_COL - 1]).trim().toLowerCase();
    if (name && !rowIndexByName.has(name)) rowIndexByName.set(name, index);
  });

  const additionsByIndex = new Map();
  for (const item of matched) {
    const key = String(item.resolvedProduct).trim().toLowerCase();
    const index = rowIndexByName.get(key);
    if (index === undefined) {
      Logger.log(`Product not found in sheet: ${item.resolvedProduct}`);
      continue;
    }

    const quantity = Number(item.quantity) || 0;
    additionsByIndex.set(index, (additionsByIndex.get(index) || 0) + quantity);
  }

  const qtyValues = data.map((row, index) => {
    const currentStock = Number(row[SHEET_CONFIG.INVENTORY.QTY_COL - 1]) || 0;
    const addition = additionsByIndex.get(index) || 0;

    if (addition > 0) {
      Logger.log(`Updated ${row[0]}: ${currentStock} + ${addition} = ${currentStock + addition}`);
    }
    return [currentStock + addition];
  });

  sheet.getRange(2, SHEET_CONFIG.INVENTORY.QTY_COL, lastRow - 1, 1).setValues(qtyValues);
}

function learnAliases(items) {
  const seen = new Set();
  const pairs = [];

  for (const item of items) {
    if (item.status !== 'matched') continue;
    if ((Number(item.confidence) || 0) < MATCH_CONFIG.ALIAS_LEARN_CONFIDENCE) continue;

    const scanned = String(item.productName || '').trim();
    const canonical = String(item.resolvedProduct || '').trim();
    if (!scanned || !canonical) continue;

    const scannedKey = normalizeProductName(scanned);
    if (!scannedKey || scannedKey === normalizeProductName(canonical) || seen.has(scannedKey)) continue;

    seen.add(scannedKey);
    pairs.push([scanned, canonical]);
  }

  if (pairs.length) appendProductAliases(pairs);
}

function appendScanLog(items) {
  if (!items.length) return;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_CONFIG.SCAN_LOG.NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_CONFIG.SCAN_LOG.NAME);
    sheet.appendRow(SHEET_CONFIG.SCAN_LOG.HEADERS);
  }

  const rows = items.map(item => [
    new Date(),
    item.productName,
    item.quantity,
    item.unit,
    item.resolvedProduct,
    Math.round(item.confidence * 100) / 100,
    item.status
  ]);

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
}
