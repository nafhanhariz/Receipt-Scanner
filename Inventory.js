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
    const lastCol = aliasSheet.getLastColumn();
    const numCols = Math.min(lastCol, 3);
    const values = aliasSheet.getRange(2, 1, aliasSheet.getLastRow() - 1, numCols).getValues();

    for (const row of values) {
      const aliasValue = row[0];
      const canonicalValue = row[1];
      const multiplierValue = numCols >= 3 ? row[2] : null;
      const aliasKey = normalizeProductName(aliasValue);
      const canonical = String(canonicalValue == null ? '' : canonicalValue).trim();
      if (!aliasKey || !canonical || aliases.has(aliasKey)) continue;
      const multiplier = Number(multiplierValue);
      aliases.set(aliasKey, {
        canonical: canonical,
        multiplier: Number.isFinite(multiplier) && multiplier > 1 ? multiplier : 1
      });
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

  for (const pair of aliasPairs) {
    const alias = Array.isArray(pair) ? pair[0] : pair.alias;
    const canonicalValue = Array.isArray(pair) ? pair[1] : pair.canonical;
    const multiplier = Array.isArray(pair) && pair[2] ? pair[2] : 1;
    const aliasKey = normalizeProductName(alias);
    const canonical = String(canonicalValue == null ? '' : canonicalValue).trim();
    if (!aliasKey || !canonical || existing.has(aliasKey) || pending.has(aliasKey)) continue;

    pending.add(aliasKey);
    rows.push([String(alias).trim(), canonical, multiplier > 1 ? multiplier : '']);
  }

  if (!rows.length) return 0;

  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = spreadsheet.getSheetByName(SHEET_CONFIG.ALIAS.NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_CONFIG.ALIAS.NAME);
    sheet.appendRow(SHEET_CONFIG.ALIAS.HEADERS);
  }

  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
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
  const matched = items.filter(item => item.status === 'matched' || item.status === 'added');
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
    const productToUpdate = item.resolvedProduct || item.productName;
    const key = String(productToUpdate).trim().toLowerCase();
    const index = rowIndexByName.get(key);
    if (index === undefined) {
      Logger.log(`Product not found in sheet: ${productToUpdate}`);
      continue;
    }

    const quantity = Number(item.effectiveQuantity !== undefined ? item.effectiveQuantity : item.quantity) || 0;
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

function getQuantityMultiplier(item) {
  const aliasMap = getProductAliases();
  const scannedKey = normalizeProductName(item.productName);
  const aliasEntry = aliasMap.get(scannedKey);
  if (aliasEntry && typeof aliasEntry === 'object' && aliasEntry.multiplier && aliasEntry.multiplier > 1) {
    return aliasEntry.multiplier;
  }
  // Also check by resolved product
  if (item.resolvedProduct) {
    const resolvedKey = normalizeProductName(item.resolvedProduct);
    const resolvedEntry = aliasMap.get(resolvedKey);
    if (resolvedEntry && typeof resolvedEntry === 'object' && resolvedEntry.multiplier && resolvedEntry.multiplier > 1) {
      return resolvedEntry.multiplier;
    }
  }
  return 1;
}

function learnQuantityRules(items) {
  const seen = new Set();
  for (const item of items) {
    if (item.status !== 'matched' && item.status !== 'added') continue;
    if (!item.reviewed) continue;
    if (item.quantityLearned) continue;
    
    const originalQty = Number(item.originalQuantity);
    const currentQty = Number(item.quantity);
    if (!Number.isFinite(originalQty) || !Number.isFinite(currentQty)) continue;
    if (originalQty <= 0 || currentQty <= 0) continue;
    if (originalQty === currentQty) continue;
    
    const ratio = currentQty / originalQty;
    if (ratio < 1.5) continue;
    if (Math.abs(ratio - Math.round(ratio)) > 0.01) continue;
    const multiplier = Math.round(ratio);
    if (multiplier > 50) continue;
    
    const scanned = String(item.productName || '').trim();
    const canonical = String(item.resolvedProduct || scanned).trim();
    if (!scanned) continue;
    
    const scannedKey = normalizeProductName(scanned);
    const aliasMap = getProductAliases();
    if (aliasMap.has(scannedKey)) {
      const existing = aliasMap.get(scannedKey);
      if (existing && typeof existing === 'object' && existing.multiplier && existing.multiplier > 1) {
        item.quantityLearned = true;
        continue;
      }
    }
    
    const ruleKey = scannedKey + '|' + multiplier;
    if (seen.has(ruleKey)) continue;
    seen.add(ruleKey);
    
    appendProductAliases([[scanned, canonical, multiplier]]);
    item.quantityLearned = true;
  }
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
