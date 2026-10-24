function parseReviewEdits(text) {
  const edits = {};
  String(text || '').split(/[,;\n]/).forEach(part => {
    const pair = part.split('=');
    if (pair.length !== 2) return;

    const key = pair[0].trim().toLowerCase();
    const value = pair[1].trim();

    if (key === 'name' || key === 'n') edits.name = value;
    else if (key === 'qty' || key === 'quantity' || key === 'q') edits.qty = value;
    else if (key === 'unit' || key === 'u') edits.unit = value;
  });
  return edits;
}

function promptForItemReview(ui, entry) {
  const item = entry;
  const suggestions = Array.isArray(entry.suggestions) ? entry.suggestions : [];

  let message =
    `Scanned -> name: "${item.productName}", qty: ${item.quantity}, unit: "${item.unit}"`;

  if (suggestions.length) {
    message += '\n\nPossible matches:';
    suggestions.forEach((suggestion, index) => {
      const score = Math.round((Number(suggestion.score) || 0) * 100);
      message += `\n${index + 1}. ${suggestion.product} (${score}%)`;
    });
    message += '\nEnter a number to accept that match.';
  }

  message +=
    '\n\nChoose one:' +
    '\n- Press OK with the box empty: accept as scanned and add to Inventory Master' +
    '\n- Edit values: qty = 2, unit = dus, name = Some Product' +
    '\n- Press Cancel: skip this item';

  while (true) {
    const response = ui.prompt('Unrecognized Item Review', message, ui.ButtonSet.OK_CANCEL);
    if (response.getSelectedButton() !== ui.Button.OK) return { skip: true };

    const rawInput = String(response.getResponseText()).trim();
    if (/^\d+$/.test(rawInput)) {
      const index = Number(rawInput) - 1;
      if (index >= 0 && index < suggestions.length) {
        return {
          skip: false,
          name: String(suggestions[index].product).trim(),
          quantity: Number(item.quantity),
          unit: String(item.unit).trim() || 'pcs'
        };
      }
      ui.alert('That suggestion number does not exist. Try again.');
      continue;
    }

    const edits = parseReviewEdits(rawInput);
    const name = String(edits.name !== undefined ? edits.name : item.productName).trim();
    const quantity = Number(edits.qty !== undefined ? edits.qty : item.quantity);
    const unit = String(edits.unit !== undefined ? edits.unit : item.unit).trim() || 'pcs';

    if (!name) {
      ui.alert('Product name cannot be empty. Try again.');
      continue;
    }
    if (!Number.isFinite(quantity) || quantity <= 0) {
      ui.alert('Quantity must be a positive number. Try again.');
      continue;
    }

    return { skip: false, name, quantity, unit };
  }
}

function resolveUnrecognizedItems(items, userProductList) {
  const unmatched = items.filter(item => item.status === 'unmatched' && !item.reviewed);
  if (!unmatched.length) return;

  let ui;
  try {
    ui = SpreadsheetApp.getUi();
  } catch (error) {
    unmatched.forEach(item => {
      Logger.log(`No UI available; leaving unreviewed: ${item.productName}`);
      item.status = 'unreviewed';
      item.reviewed = true;
    });
    return;
  }

  const productNames = userProductList && userProductList.length
    ? userProductList
    : getUserProductList();
  const canonicalByName = buildCanonicalNameMap(productNames);
  const rowsToAppend = [];
  const learnedAliases = [];

  for (const item of unmatched) {
    const review = promptForItemReview(ui, item);
    item.reviewed = true;

    if (review.skip) {
      item.status = 'skipped';
      continue;
    }

    const scannedName = String(item.productName || '').trim();
    const resolvedName = String(review.name || '').trim();
    if (scannedName && resolvedName &&
        normalizeProductName(scannedName) !== normalizeProductName(resolvedName)) {
      learnedAliases.push([scannedName, resolvedName]);
    }

    const existing = canonicalByName.get(normalizeProductName(review.name));
    if (existing) {
      item.productName = item.productName;
      item.resolvedProduct = existing;
      item.quantity = review.quantity;
      item.unit = review.unit;
      item.status = 'matched';
      continue;
    }

    rowsToAppend.push([review.name, review.quantity, review.unit]);
    item.resolvedProduct = review.name;
    item.quantity = review.quantity;
    item.unit = review.unit;
    item.status = 'added';
  }

  if (rowsToAppend.length) appendInventoryRows(rowsToAppend);
  if (learnedAliases.length) appendProductAliases(learnedAliases);
}
