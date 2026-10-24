function buildLineItems(rawItems) {
  return (rawItems || []).map(item => ({
    productName: String(item && item.productName ? item.productName : '').trim(),
    quantity: Number(item && item.quantity) || 0,
    unit: String(item && item.unit ? item.unit : '').trim() || 'pcs',
    status: null,
    resolvedProduct: '',
    confidence: 0,
    suggestions: []
  }));
}

function matchLineItems(items, productList, productAliases) {
  const matcher = productList instanceof ProductMatcher
    ? productList
    : new ProductMatcher(productList, productAliases);

  items.forEach(item => {
    const result = matcher.match(item.productName);
    if (result.matchedProduct) {
      item.status = 'matched';
      item.resolvedProduct = result.matchedProduct;
      item.confidence = result.confidence;
      item.suggestions = [];
    } else {
      item.status = 'unmatched';
      item.resolvedProduct = '';
      item.confidence = result.confidence;
      item.suggestions = result.suggestions;
    }
  });
}

function processReceiptBlob(blob) {
  const rawItems = extractReceiptItems(blob);
  const lineItems = buildLineItems(rawItems);

  const productList = getUserProductList();
  const productAliases = getProductAliases();

  matchLineItems(lineItems, productList, productAliases);
  resolveUnmatchedWithGemini(lineItems, productList, productAliases);
  resolveUnrecognizedItems(lineItems, productList);

  updateInventoryStock(lineItems);
  learnAliases(lineItems);
  appendScanLog(lineItems);

  const summary = { total: lineItems.length, matched: 0, added: 0, skipped: 0, unreviewed: 0 };
  lineItems.forEach(item => {
    if (summary[item.status] !== undefined) summary[item.status]++;
  });
  return summary;
}

function processUploadedBlob(base64Data, fileName, mimeType) {
  if (!base64Data) {
    throw new Error('No file data was received. Please select a receipt image and try again.');
  }

  let blob;
  try {
    blob = Utilities.newBlob(
      Utilities.base64Decode(base64Data),
      mimeType || 'image/jpeg',
      fileName || 'receipt.jpg'
    );
  } catch (error) {
    throw new Error(`Could not read the uploaded file: ${error.message}`);
  }

  return processReceiptBlob(blob);
}

function getLatestReceiptFile() {
  const folderIds = initializeDriveFolders();
  const queueFolder = DriveApp.getFolderById(folderIds['Receipt Queue']);
  const files = queueFolder.getFilesByType(MimeType.JPEG);
  let latestFile = null;
  let latestDate = 0;

  while (files.hasNext()) {
    const file = files.next();
    const date = file.getLastUpdated().getTime();
    if (!latestFile || date > latestDate) {
      latestFile = file;
      latestDate = date;
    }
  }

  const pngFiles = queueFolder.getFilesByType(MimeType.PNG);
  while (pngFiles.hasNext()) {
    const file = pngFiles.next();
    const date = file.getLastUpdated().getTime();
    if (!latestFile || date > latestDate) {
      latestFile = file;
      latestDate = date;
    }
  }

  const jpgFiles = queueFolder.getFilesByType(MimeType.JPG);
  while (jpgFiles.hasNext()) {
    const file = jpgFiles.next();
    const date = file.getLastUpdated().getTime();
    if (!latestFile || date > latestDate) {
      latestFile = file;
      latestDate = date;
    }
  }

  if (!latestFile) {
    throw new Error('No receipt files found in Receipt Queue.');
  }
  return latestFile;
}

function Main() {
  const file = getLatestReceiptFile();
  processReceiptBlob(file.getBlob());
  processedFile(file);
}

function processedFile(file) {
  const folderIds = initializeDriveFolders();
  const processedFolder = DriveApp.getFolderById(folderIds['Processed Receipts']);
  file.moveToFolder(processedFolder);
}
