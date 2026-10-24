function requestGeminiJson(payload) {
  const apiUrl = `${GEMINI_CONFIG.API_BASE}${GEMINI_CONFIG.MODEL}:generateContent?key=${getStoredApiKey()}`;
  const options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  let result = null;
  for (let attempt = 0; attempt < GEMINI_CONFIG.MAX_ATTEMPTS; attempt++) {
    try {
      const response = UrlFetchApp.fetch(apiUrl, options);
      result = JSON.parse(response.getContentText());
    } catch (error) {
      Logger.log(`Fetch attempt ${attempt + 1} failed: ${error.message}`);
      Utilities.sleep(GEMINI_CONFIG.RETRY_DELAY_MS);
      continue;
    }

    const errorCode = result.error && result.error.code;
    if (errorCode === 503 || errorCode === 429 || (errorCode >= 500 && errorCode < 600)) {
      Logger.log(`Gemini API error ${errorCode}. Retrying... Attempt ${attempt + 1}`);
      Utilities.sleep(GEMINI_CONFIG.RETRY_DELAY_MS);
      continue;
    }
    break;
  }

  if (!result) {
    throw new Error(`Gemini API unreachable after ${GEMINI_CONFIG.MAX_ATTEMPTS} attempts.`);
  }
  if (result.error) {
    throw new Error(`Gemini API failed: ${result.error.message}`);
  }
  if (!result.candidates || !result.candidates.length) {
    throw new Error('Gemini returned no candidates.');
  }

  const parts = (result.candidates[0].content && result.candidates[0].content.parts) || [];
  const textPart = parts.find(part => typeof part.text === 'string');
  if (!textPart) {
    throw new Error('Gemini returned an empty response.');
  }

  try {
    return JSON.parse(textPart.text);
  } catch (error) {
    throw new Error(`Gemini did not return valid JSON: ${textPart.text}`);
  }
}

function extractReceiptItems(blob) {
  const payload = {
    contents: [{
      parts: [
        { text: 'Extract each product purchased from this receipt image.' },
        {
          inlineData: {
            mimeType: blob.getContentType(),
            data: Utilities.base64Encode(blob.getBytes())
          }
        }
      ]
    }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          items: {
            type: 'ARRAY',
            description: 'List of items found on the receipt.',
            items: {
              type: 'OBJECT',
              properties: {
                productName: {
                  type: 'STRING',
                  description: 'Product name exactly as printed on the receipt.'
                },
                quantity: {
                  type: 'INTEGER',
                  description: 'Numeric quantity of the product purchased.'
                },
                unit: {
                  type: 'STRING',
                  description: "Unit as observed on the receipt (e.g. 'pcs','krt','dus','pack','renceng','kg'). Use 'pcs' only when no unit is printed."
                }
              },
              required: ['productName', 'quantity', 'unit']
            }
          }
        },
        required: ['items']
      }
    }
  };

  const parsed = requestGeminiJson(payload);
  return (Array.isArray(parsed.items) ? parsed.items : [])
    .filter(item => item && typeof item === 'object' && item.productName);
}

function resolveUnmatchedWithGemini(items, userProductList, productAliases) {
  const pending = items.filter(item => item.status === 'unmatched');
  if (!pending.length) return;

  const productNames = (userProductList || [])
    .map(name => String(name == null ? '' : name).trim())
    .filter(Boolean);
  const canonicalByName = buildCanonicalNameMap(productNames);
  const fullCatalog = productNames.length <= GEMINI_CONFIG.FULL_CATALOG_LIMIT
    ? productNames
    : null;

  const aliasEntries = productAliases instanceof Map
    ? Array.from(productAliases.entries())
    : Object.entries(productAliases || {});
  const knownAliases = aliasEntries
    .filter(([, canonical]) => canonicalByName.has(normalizeProductName(canonical)))
    .slice(0, GEMINI_CONFIG.ALIAS_LIMIT);

  for (let start = 0; start < pending.length; start += GEMINI_CONFIG.BATCH_SIZE) {
    const batch = pending.slice(start, start + GEMINI_CONFIG.BATCH_SIZE);
    let resultsById = new Map();

    try {
      resultsById = requestSemanticMatches(batch, fullCatalog, knownAliases);
    } catch (error) {
      Logger.log(`Gemini semantic matching failed: ${error.message}`);
    }

    batch.forEach((entry, index) => {
      const result = resultsById.get(index);
      const confidence = result && Number.isFinite(result.confidence)
        ? Math.max(0, Math.min(1, Number(result.confidence)))
        : 0;
      const canonical = result && result.matchedProduct
        ? canonicalByName.get(normalizeProductName(result.matchedProduct))
        : null;

      if (!canonical) return;

      if (confidence >= GEMINI_CONFIG.MATCH_THRESHOLD) {
        entry.status = 'matched';
        entry.resolvedProduct = canonical;
        entry.confidence = confidence;
        entry.suggestions = [];
        return;
      }

      entry.confidence = Math.max(entry.confidence || 0, confidence);

      const merged = new Map();
      [...(entry.suggestions || []), { product: canonical, score: confidence }]
        .forEach(suggestion => {
          if (!suggestion || !suggestion.product) return;

          const key = String(suggestion.product).toLowerCase();
          const score = Math.max(0, Math.min(1, Number(suggestion.score) || 0));
          const existing = merged.get(key);

          if (existing) {
            existing.score = Math.max(existing.score, score);
          } else {
            merged.set(key, { product: suggestion.product, score });
          }
        });

      entry.suggestions = Array.from(merged.values())
        .sort((a, b) => b.score - a.score)
        .slice(0, MATCH_CONFIG.MAX_SUGGESTIONS);
    });
  }
}

function requestSemanticMatches(batch, fullCatalog, knownAliases) {
  const items = batch.map((entry, id) => ({
    id,
    scannedName: entry.productName,
    quantity: entry.quantity,
    unit: entry.unit,
    candidates: (entry.suggestions || [])
      .slice(0, GEMINI_CONFIG.CANDIDATES_PER_ITEM)
      .map(suggestion => suggestion.product)
  }));

  const requestData = { items };
  if (fullCatalog) requestData.productCatalog = fullCatalog;
  if (knownAliases.length) requestData.knownAliases = knownAliases;

  const instructions =
    'Match each scanned receipt item in the JSON data to one product from the ' +
    'merchant inventory.\n' +
    'Use semantic reasoning for receipt abbreviations, truncation, misspellings, ' +
    'brand/type/size clues, and Indonesian/English retail conventions.\n' +
    'knownAliases lists merchant-specific abbreviations already learned from prior ' +
    'receipts: treat each [alias, canonical] pair as a strong hint.\n' +
    "Choose only a name that appears in productCatalog or that item's candidates. " +
    'Never invent a product name. If nothing is plausible, return an empty ' +
    'matchedProduct and confidence 0.';

  const payload = {
    systemInstruction: {
      parts: [{
        text: 'You are a product-name matching engine for a receipt scanner. ' +
          'Return only products that exist in the provided catalog or candidate list. ' +
          'Confidence is a number from 0 to 1.'
      }]
    },
    contents: [{
      role: 'user',
      parts: [
        { text: instructions },
        { text: JSON.stringify(requestData) }
      ]
    }],
    generationConfig: {
      temperature: 0,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          results: {
            type: 'ARRAY',
            items: {
              type: 'OBJECT',
              properties: {
                id: {
                  type: 'INTEGER',
                  description: 'The id of the scanned item being matched.'
                },
                matchedProduct: {
                  type: 'STRING',
                  description: 'Exact catalog/candidate name, or an empty string if none match.'
                },
                confidence: {
                  type: 'NUMBER',
                  description: 'Matching confidence from 0 to 1.'
                },
                reason: {
                  type: 'STRING',
                  description: 'Short explanation for the match.'
                }
              },
              required: ['id', 'matchedProduct', 'confidence']
            }
          }
        },
        required: ['results']
      }
    }
  };

  const parsed = requestGeminiJson(payload);
  const results = Array.isArray(parsed.results) ? parsed.results : [];
  const resultsById = new Map();

  results.forEach(result => {
    if (!result || typeof result !== 'object') return;

    const id = Number(result.id);
    if (!Number.isInteger(id) || id < 0 || id >= batch.length) return;
    resultsById.set(id, result);
  });

  return resultsById;
}
