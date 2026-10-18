const ONE_MILLION = 1_000_000;

function asFiniteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : undefined;
}

function findCaseInsensitiveKey(record, desiredKey) {
  if (!record || typeof record !== 'object' || !desiredKey) return undefined;
  if (Object.hasOwn(record, desiredKey)) return record[desiredKey];
  const normalized = String(desiredKey).toLowerCase();
  const matchingKey = Object.keys(record).find((key) => key.toLowerCase() === normalized);
  return matchingKey ? record[matchingKey] : undefined;
}

function normalizeRates(rateEntry) {
  if (!rateEntry || typeof rateEntry !== 'object' || Array.isArray(rateEntry)) return null;
  const inputPer1MUsd = asFiniteNonNegative(rateEntry.inputPer1MUsd);
  const outputPer1MUsd = asFiniteNonNegative(rateEntry.outputPer1MUsd);
  const cachedInputPer1MUsd = asFiniteNonNegative(rateEntry.cachedInputPer1MUsd);
  return {
    inputPer1MUsd,
    outputPer1MUsd,
    cachedInputPer1MUsd,
    inputConfigured: inputPer1MUsd !== undefined,
    outputConfigured: outputPer1MUsd !== undefined,
    cachedInputConfigured: cachedInputPer1MUsd !== undefined,
    complete: inputPer1MUsd !== undefined && outputPer1MUsd !== undefined,
    pricingSource: typeof rateEntry.pricingSource === 'string' ? rateEntry.pricingSource : null,
    effectiveDate: typeof rateEntry.effectiveDate === 'string' ? rateEntry.effectiveDate : null,
    tier: typeof rateEntry.tier === 'string' ? rateEntry.tier : null,
    assumptions: Array.isArray(rateEntry.assumptions) ? rateEntry.assumptions : []
  };
}

function formatMissingRates(rates) {
  if (!rates) return 'both input and output rates are missing';
  if (!rates.inputConfigured && !rates.outputConfigured) return 'both input and output rates are missing';
  if (!rates.inputConfigured) return 'the input rate is missing';
  if (!rates.outputConfigured) return 'the output rate is missing';
  return '';
}

function calculateUsd(inputTokens, outputTokens, inputRate, outputRate) {
  return Number(((inputTokens * inputRate + outputTokens * outputRate) / ONE_MILLION).toFixed(10));
}

function withSnapshot(details, rates, rateSource) {
  return {
    ...details,
    rateSource,
    pricingSource: rates?.pricingSource ?? (rateSource === 'provider-default' ? 'provider-wide environment configuration' : 'model-specific environment configuration'),
    pricingEffectiveDate: rates?.effectiveDate ?? null,
    pricingTier: rates?.tier ?? null,
    pricingAssumptions: rates?.assumptions ?? [],
    pricingCapturedAt: new Date().toISOString()
  };
}

/**
 * Estimate USD usage using exact model rates first, then provider-wide rates.
 * Cached input is priced separately only when a cached rate is configured.
 * Unsupported billable categories make the total incomplete; known components
 * remain available as an explicit subtotal.
 */
export function estimateCostDetails({
  provider,
  model,
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  unpricedInputTokens = 0,
  unsupportedCategories = [],
  modelCostRates = {},
  providerCostRates = {}
}) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const normalizedModel = String(model ?? '').trim();
  const safeInputTokens = asFiniteNonNegative(inputTokens) ?? 0;
  const safeOutputTokens = asFiniteNonNegative(outputTokens) ?? 0;
  const safeCachedInputTokens = asFiniteNonNegative(cachedInputTokens) ?? 0;
  const safeUnpricedInputTokens = asFiniteNonNegative(unpricedInputTokens) ?? 0;

  if (normalizedProvider === 'mock') {
    return {
      pricingStatus: 'not_applicable', estimatedCostUsd: 0, knownEstimatedCostUsd: 0,
      rateSource: 'mock', pricingSource: 'mock', pricingEffectiveDate: null, pricingTier: null,
      pricingAssumptions: ['Local deterministic fixture; no provider API request.'],
      pricingCapturedAt: new Date().toISOString(), model: normalizedModel || 'mock',
      inputRatePer1MUsd: null, outputRatePer1MUsd: null, cachedInputRatePer1MUsd: null,
      explanation: 'The Mock provider uses local fixtures and makes no model API calls; no API usage charge is incurred.'
    };
  }

  const providerModelRates = findCaseInsensitiveKey(modelCostRates, normalizedProvider) ?? {};
  const exactEntry = normalizedModel ? findCaseInsensitiveKey(providerModelRates, normalizedModel) : undefined;
  const exactRates = normalizeRates(exactEntry);
  const providerRates = normalizeRates(findCaseInsensitiveKey(providerCostRates, normalizedProvider));
  const rates = exactRates?.complete ? exactRates : providerRates?.complete ? providerRates : null;
  const rateSource = exactRates?.complete ? 'model-specific' : providerRates?.complete ? 'provider-default' : null;

  if (!rates) {
    const missingDetail = exactEntry
      ? `The model-specific rate for ${normalizedProvider}/${normalizedModel} is incomplete (${formatMissingRates(exactRates)}).`
      : `No complete model-specific rate is configured for ${normalizedProvider}/${normalizedModel || 'unknown model'}.`;
    const hasAnyProviderRate = Boolean(providerRates && (providerRates.inputConfigured || providerRates.outputConfigured));
    const fallbackDetail = hasAnyProviderRate
      ? ` Provider-wide fallback rates are also incomplete (${formatMissingRates(providerRates)}).`
      : ' Provider-wide fallback rates are not configured.';
    return {
      pricingStatus: 'unavailable', estimatedCostUsd: null, knownEstimatedCostUsd: null,
      rateSource: null, pricingSource: null, pricingEffectiveDate: null, pricingTier: null,
      pricingAssumptions: [], pricingCapturedAt: new Date().toISOString(),
      model: normalizedModel || null,
      inputRatePer1MUsd: exactRates?.inputPer1MUsd ?? null,
      outputRatePer1MUsd: exactRates?.outputPer1MUsd ?? null,
      cachedInputRatePer1MUsd: exactRates?.cachedInputPer1MUsd ?? null,
      explanation: `Estimated cost unavailable: ${missingDetail}${fallbackDetail} Configure inputPer1MUsd and outputPer1MUsd in MODEL_COST_RATES_JSON, or set both provider-wide rate variables, then run a new evaluation.`
    };
  }

  const cachedTokensToPrice = Math.min(safeCachedInputTokens, safeInputTokens);
  const unpricedTokensToExclude = Math.min(safeUnpricedInputTokens, Math.max(0, safeInputTokens - cachedTokensToPrice));
  const nonCachedInputTokens = Math.max(0, safeInputTokens - cachedTokensToPrice - unpricedTokensToExclude);
  const knownInputCost = nonCachedInputTokens * rates.inputPer1MUsd / ONE_MILLION;
  const knownOutputCost = safeOutputTokens * rates.outputPer1MUsd / ONE_MILLION;
  const cachedRateAvailable = safeCachedInputTokens === 0 || rates.cachedInputConfigured;
  const knownCachedCost = cachedTokensToPrice > 0 && rates.cachedInputConfigured
    ? cachedTokensToPrice * rates.cachedInputPer1MUsd / ONE_MILLION : 0;
  const knownEstimatedCostUsd = Number((knownInputCost + knownOutputCost + knownCachedCost).toFixed(10));
  const uncappedCategories = Array.isArray(unsupportedCategories) ? unsupportedCategories : [];
  const unresolved = [
    ...(safeCachedInputTokens + safeUnpricedInputTokens > safeInputTokens ? ['provider usage subcategories exceed the reported input token total'] : []),
    ...(safeCachedInputTokens > 0 && !cachedRateAvailable ? ['cached input tokens were reported but no cachedInputPer1MUsd rate is configured'] : []),
    ...uncappedCategories.map((category) => `${category} usage was reported but no configured rate is available`)
  ];
  const pricingStatus = unresolved.length ? (knownEstimatedCostUsd > 0 ? 'partial' : 'unavailable') : 'estimated';
  const detail = exactRates?.complete
    ? `Configured model-specific rates for ${normalizedProvider}/${normalizedModel}.`
    : `No complete model-specific rate is configured for ${normalizedProvider}/${normalizedModel || 'unknown model'}. Estimated using provider-wide fallback rates; this may not match the exact model's price.`;
  const explanation = unresolved.length
    ? `${detail} Known subtotal: $${knownEstimatedCostUsd.toFixed(8)}. Full cost unavailable: ${unresolved.join('; ')}.`
    : `${detail}${safeCachedInputTokens ? ' Cached input tokens were priced using the configured cached input rate.' : ''}`;

  return withSnapshot({
    pricingStatus,
    estimatedCostUsd: unresolved.length ? null : knownEstimatedCostUsd,
    knownEstimatedCostUsd,
    model: normalizedModel || null,
    inputRatePer1MUsd: rates.inputPer1MUsd,
    outputRatePer1MUsd: rates.outputPer1MUsd,
    cachedInputRatePer1MUsd: rates.cachedInputConfigured ? rates.cachedInputPer1MUsd : null,
    explanation
  }, rates, rateSource);
}
