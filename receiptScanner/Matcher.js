function normalizeProductName(value) {
  let text = String(value == null ? '' : value).toLowerCase();

  if (typeof text.normalize === 'function') {
    text = text.normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  }

  text = text.replace(/&/g, ' dan ');
  text = text.replace(/([a-z])([0-9])/g, '$1 $2');
  text = text.replace(/([0-9])([a-z])/g, '$1 $2');
  text = text.replace(/[^a-z0-9]+/g, ' ');
  return text.replace(/\s+/g, ' ').trim();
}

function buildCanonicalNameMap(productNames) {
  const map = new Map();
  productNames.forEach(name => {
    const key = normalizeProductName(name);
    if (key && !map.has(key)) map.set(key, name);
  });
  return map;
}

class ProductMatcher {
  constructor(userProductList, productAliases) {
    const names = [];
    const seen = new Set();

    for (const value of userProductList || []) {
      const name = String(value == null ? '' : value).trim();
      if (!name) continue;

      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(name);
    }

    this.names = names;
    this.products = names.map((name, index) => this.prepareEntry(name, index));
    this.exactNormalized = new Map();
    this.exactCore = new Map();
    this.exactCoreNoSize = new Map();
    this.tokenIndex = new Map();
    this.tokenPrefixIndex = new Map();
    this.tokenFirstCharIndex = new Map();

    for (const product of this.products) {
      this.addToIndex(this.exactNormalized, product.normalized, product.index);
      if (product.core) this.addToIndex(this.exactCore, product.core, product.index);
      if (product.coreNoSize) this.addToIndex(this.exactCoreNoSize, product.coreNoSize, product.index);

      const seenTokens = new Set();
      for (const token of product.tokens) {
        if (!token || seenTokens.has(token)) continue;
        seenTokens.add(token);

        this.addToIndex(this.tokenIndex, token, product.index);
        if (token.length >= 3) {
          this.addToIndex(this.tokenPrefixIndex, token.slice(0, 3), product.index);
        }
        this.addToIndex(this.tokenFirstCharIndex, token.charAt(0), product.index);
      }
    }

    this.aliasExact = new Map();
    this.aliasCore = new Map();
    this.aliasCoreNoSize = new Map();
    this.buildAliasIndex(productAliases);
  }

  prepareEntry(name, index) {
    const normalized = normalizeProductName(name);
    const tokens = normalized
      ? normalized.split(' ').map(token => RECEIPT_TOKEN_ALIASES[token] || token)
      : [];
    const coreTokens = tokens.filter(token => token && !RECEIPT_NOISE_TOKENS.has(token));
    const coreNoSizeTokens = coreTokens.filter(token => !/^\d+$/.test(token));

    return {
      name,
      index,
      normalized,
      search: tokens.join(' '),
      tokens,
      weights: tokens.map(token => {
        if (!token) return 0;
        if (/^\d+$/.test(token)) return 1.15;
        if (RECEIPT_NOISE_TOKENS.has(token)) return 0.15;
        if (token.length <= 2) return 0.65;
        return 1;
      }),
      numbers: tokens.filter(token => /^\d+$/.test(token)),
      core: coreTokens.join(' '),
      coreNoSize: coreNoSizeTokens.join(' ')
    };
  }

  addToIndex(map, key, index) {
    if (!key) return;
    const bucket = map.get(key);
    if (!bucket) {
      map.set(key, [index]);
      return;
    }
    if (bucket[bucket.length - 1] !== index) bucket.push(index);
  }

  buildAliasIndex(productAliases) {
    const entries = productAliases instanceof Map
      ? productAliases
      : new Map(Object.entries(productAliases || {}));

    for (const [aliasText, aliasCanonical] of entries) {
      const canonicalName = String(aliasCanonical == null ? '' : aliasCanonical).trim();
      const canonicalMatches = this.exactNormalized.get(normalizeProductName(canonicalName));
      if (!canonicalMatches || !canonicalMatches.length) continue;

      const canonicalProduct = this.products[canonicalMatches[0]];
      const canonical = canonicalProduct.name;
      const aliasEntry = this.prepareEntry(aliasText, -1);

      const addAlias = (map, key) => {
        if (!key) return;

        const entry = {
          canonical,
          numbers: aliasEntry.numbers,
          canonicalNumbers: canonicalProduct.numbers
        };
        const bucket = map.get(key);

        if (!bucket) {
          map.set(key, [entry]);
          return;
        }
        if (!bucket.some(existing => existing.canonical === canonical)) bucket.push(entry);
      };

      addAlias(this.aliasExact, aliasEntry.normalized);
      addAlias(this.aliasCore, aliasEntry.core);
      addAlias(this.aliasCoreNoSize, aliasEntry.coreNoSize);
    }
  }

  findAliasMatch(entries, query, requireSizeCompatibility) {
    if (!entries || entries.length !== 1) return null;

    const entry = entries[0];
    if (requireSizeCompatibility && query.numbers.length) {
      const relevantNumbers = entry.numbers.length ? entry.numbers : entry.canonicalNumbers;
      if (relevantNumbers.length && !query.numbers.some(number => relevantNumbers.includes(number))) {
        return null;
      }
    }
    return entry.canonical;
  }

  match(productName) {
    const query = this.prepareEntry(productName, -1);
    if (!query.normalized) return { matchedProduct: null, confidence: 0, suggestions: [] };

    const exactMatches = this.exactNormalized.get(query.normalized);
    if (exactMatches && exactMatches.length) {
      return { matchedProduct: this.names[exactMatches[0]], confidence: 1, suggestions: [] };
    }

    const exactAlias = this.findAliasMatch(this.aliasExact.get(query.normalized), query, false);
    if (exactAlias) return { matchedProduct: exactAlias, confidence: 1, suggestions: [] };

    const coreMatches = query.core ? this.exactCore.get(query.core) : null;
    if (coreMatches && coreMatches.length === 1) {
      return { matchedProduct: this.names[coreMatches[0]], confidence: 0.97, suggestions: [] };
    }

    const coreAlias = query.core
      ? this.findAliasMatch(this.aliasCore.get(query.core), query, false)
      : null;
    if (coreAlias) return { matchedProduct: coreAlias, confidence: 0.99, suggestions: [] };

    const coreNoSizeMatches = query.coreNoSize
      ? this.exactCoreNoSize.get(query.coreNoSize)
      : null;
    if (coreNoSizeMatches && coreNoSizeMatches.length === 1) {
      const product = this.products[coreNoSizeMatches[0]];
      const sizeCompatible = !query.numbers.length ||
        !product.numbers.length ||
        query.numbers.some(number => product.numbers.includes(number));

      if (sizeCompatible) {
        return { matchedProduct: product.name, confidence: 0.95, suggestions: [] };
      }
    }

    const coreNoSizeAlias = query.coreNoSize
      ? this.findAliasMatch(this.aliasCoreNoSize.get(query.coreNoSize), query, true)
      : null;
    if (coreNoSizeAlias) return { matchedProduct: coreNoSizeAlias, confidence: 0.96, suggestions: [] };

    const scored = this.collectCandidates(query).map(index => {
      const product = this.products[index];
      return { product: product.name, score: this.scoreProductMatch(query, product) };
    });

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.product.localeCompare(b.product);
    });

    const suggestions = scored
      .filter(entry => entry.score >= MATCH_CONFIG.SUGGESTION_THRESHOLD)
      .slice(0, MATCH_CONFIG.MAX_SUGGESTIONS)
      .map(entry => ({ product: entry.product, score: entry.score }));

    const [best, second] = scored;
    const isAmbiguous = Boolean(best && second &&
      best.score >= MATCH_CONFIG.THRESHOLD &&
      (best.score - second.score) < MATCH_CONFIG.AMBIGUITY_MARGIN);

    if (best && best.score >= MATCH_CONFIG.THRESHOLD && !isAmbiguous) {
      return { matchedProduct: best.product, confidence: best.score, suggestions };
    }

    return {
      matchedProduct: null,
      confidence: best ? best.score : 0,
      suggestions
    };
  }

  collectCandidates(query) {
    const hits = new Map();
    const add = (index, weight) => {
      if (index === undefined || index === null) return;
      hits.set(index, (hits.get(index) || 0) + weight);
    };
    const addAll = (indices, weight) => {
      if (!indices) return;
      indices.forEach(index => add(index, weight));
    };

    addAll(this.exactNormalized.get(query.normalized), 1000);
    if (query.core) addAll(this.exactCore.get(query.core), 500);

    const buckets = [];
    const queueBucket = (indices, weight) => {
      if (!indices || !indices.length) return;
      buckets.push({ indices, weight, size: indices.length });
    };

    query.tokens.forEach((token, index) => {
      if (!token) return;
      const weight = query.weights[index] || 1;
      queueBucket(this.tokenIndex.get(token), 6 * weight);
      if (token.length >= 3) {
        queueBucket(this.tokenPrefixIndex.get(token.slice(0, 3)), 2 * weight);
      }
    });

    buckets.sort((a, b) => a.size - b.size);

    const addLimit = MATCH_CONFIG.MAX_CANDIDATES * 2;
    for (const bucket of buckets) {
      if (hits.size && bucket.size > MATCH_CONFIG.MIN_CANDIDATES &&
          hits.size + bucket.size > addLimit) {
        break;
      }
      addAll(bucket.indices, bucket.weight);
    }

    if (hits.size < MATCH_CONFIG.MIN_CANDIDATES) {
      query.tokens.forEach((token, index) => {
        if (!token) return;
        addAll(
          this.tokenFirstCharIndex.get(token.charAt(0)),
          0.25 * (query.weights[index] || 1)
        );
      });
    }

    if (!hits.size && query.normalized) {
      addAll(this.tokenFirstCharIndex.get(query.normalized.charAt(0)), 0.05);
    }

    const indices = Array.from(hits.keys());
    if (indices.length <= MATCH_CONFIG.MAX_CANDIDATES) return indices;

    indices.sort((a, b) => (hits.get(b) || 0) - (hits.get(a) || 0));
    return indices.slice(0, MATCH_CONFIG.MAX_CANDIDATES);
  }

  scoreProductMatch(query, product) {
    if (query.normalized === product.normalized) return 1;

    let queryTokens = query.tokens;
    let queryWeights = query.weights;

    if (!product.numbers.length) {
      const filteredTokens = [];
      const filteredWeights = [];

      query.tokens.forEach((token, index) => {
        if (/^\d+$/.test(token) || RECEIPT_NOISE_TOKENS.has(token)) return;
        filteredTokens.push(token);
        filteredWeights.push(query.weights[index]);
      });

      if (filteredTokens.length) {
        queryTokens = filteredTokens;
        queryWeights = filteredWeights;
      }
    }

    const queryCoverage = this.directionalCoverage(queryTokens, queryWeights, product.tokens);
    const productCoverage = this.directionalCoverage(product.tokens, product.weights, queryTokens);
    const queryCore = query.core || query.normalized;
    const productCore = product.core || product.normalized;
    const bigram = this.bigramSimilarity(queryCore, productCore);
    const order = this.lcsTokenRatio(queryTokens, product.tokens);

    let score =
      (queryCoverage * 0.5) +
      (productCoverage * 0.2) +
      (bigram * 0.2) +
      (order * 0.1);

    if (query.core && query.core === product.core) score = Math.max(score, 0.97);
    if (queryCoverage >= 0.85 && productCoverage >= 0.85) score = Math.max(score, 0.88);

    if (query.search.length >= 4 && product.search.length >= 4) {
      const startsWithOther =
        query.search.startsWith(product.search) ||
        product.search.startsWith(query.search);

      if (startsWithOther) {
        const ratio = Math.min(query.search.length, product.search.length) /
          Math.max(query.search.length, product.search.length);
        score = Math.max(score, 0.72 + (0.2 * ratio));
      }
    }

    return Math.max(0, Math.min(1, score));
  }

  directionalCoverage(fromTokens, fromWeights, toTokens) {
    if (!fromTokens.length || !toTokens.length) return 0;

    let total = 0;
    let matched = 0;

    fromTokens.forEach((fromToken, index) => {
      const weight = fromWeights[index] || 0;
      if (weight <= 0) return;

      total += weight;
      let best = 0;
      for (const toToken of toTokens) {
        const similarity = this.tokenSimilarity(fromToken, toToken);
        if (similarity > best) best = similarity;
        if (best === 1) break;
      }
      matched += weight * best;
    });

    return total > 0 ? matched / total : 0;
  }

  tokenSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (/^\d+$/.test(a) || /^\d+$/.test(b)) return 0;

    const isAbbreviation = (shortToken, longToken) => {
      if (shortToken.length < 3 || shortToken.length >= longToken.length) return false;
      if (shortToken.charAt(0) !== longToken.charAt(0)) return false;

      let index = 0;
      for (let i = 0; i < longToken.length && index < shortToken.length; i++) {
        if (longToken.charAt(i) === shortToken.charAt(index)) index++;
      }
      return index === shortToken.length;
    };

    if (a.length >= 3 && b.length >= 3) {
      if (a.startsWith(b) || b.startsWith(a)) {
        const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
        if (ratio >= 0.6) return 0.78 + (0.17 * ratio);
      }
      if (isAbbreviation(a, b) || isAbbreviation(b, a)) return 0.78;
    }

    const distance = this.levenshteinDistance(a, b);
    const similarity = 1 - (distance / Math.max(a.length, b.length));
    return similarity >= 0.78 ? similarity : 0;
  }

  levenshteinDistance(a, b) {
    if (a === b) return 0;
    if (!a.length) return b.length;
    if (!b.length) return a.length;

    let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    let current = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i++) {
      current[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        current[j] = Math.min(
          previous[j] + 1,
          current[j - 1] + 1,
          previous[j - 1] + cost
        );
      }
      const swap = previous;
      previous = current;
      current = swap;
    }

    return previous[b.length];
  }

  bigramSimilarity(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;

    const charBigrams = text => {
      if (text.length < 2) return text ? [text] : [];
      return Array.from(
        { length: text.length - 1 },
        (_, index) => text.slice(index, index + 2)
      );
    };

    const gramsA = charBigrams(a);
    const gramsB = charBigrams(b);
    if (!gramsA.length || !gramsB.length) return 0;

    const counts = new Map();
    gramsA.forEach(gram => counts.set(gram, (counts.get(gram) || 0) + 1));

    let intersection = 0;
    gramsB.forEach(gram => {
      const count = counts.get(gram) || 0;
      if (count) {
        counts.set(gram, count - 1);
        intersection++;
      }
    });

    return (2 * intersection) / (gramsA.length + gramsB.length);
  }

  lcsTokenRatio(a, b) {
    if (!a.length || !b.length) return 0;

    let previous = new Array(b.length + 1).fill(0);
    let current = new Array(b.length + 1).fill(0);

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        current[j] = a[i - 1] === b[j - 1]
          ? previous[j - 1] + 1
          : Math.max(previous[j], current[j - 1]);
      }
      const swap = previous;
      previous = current;
      current = swap;
      current.fill(0);
    }

    return previous[b.length] / Math.max(a.length, b.length);
  }
}

function buildProductMatcher(userProductList, productAliases) {
  return new ProductMatcher(userProductList, productAliases);
}

function matchProductName(productName, matcherOrUserProductList, productAliases) {
  const matcher = matcherOrUserProductList instanceof ProductMatcher
    ? matcherOrUserProductList
    : buildProductMatcher(matcherOrUserProductList, productAliases);
  return matcher.match(productName);
}
