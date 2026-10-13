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
  return {
    inputPer1MUsd,
    outputPer1MUsd,
    inputConfigured: inputPer1MUsd !== undefined,
    outputConfigured: outputPer1MUsd !== undefined,
    complete: inputPer1MUsd !== undefined && outputPer1MUsd !== undefined
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

/**
 * Estimate USD usage cost using an exact provider/model rate first, then an
 * explicitly labeled provider-wide fallback. Rates are USD per 1,000,000 tokens.
 * This function has no environment or network dependencies to make it easy to test.
 */
export function estimateCostDetails({
  provider,
  model,
  inputTokens = 0,
  outputTokens = 0,
  modelCostRates = {},
  providerCostRates = {}
}) {
  const normalizedProvider = String(provider ?? '').trim().toLowerCase();
  const normalizedModel = String(model ?? '').trim();
  const safeInputTokens = Math.max(0, Number.isFinite(Number(inputTokens)) ? Number(inputTokens) : 0);
  const safeOutputTokens = Math.max(0, Number.isFinite(Number(outputTokens)) ? Number(outputTokens) : 0);

  if (normalizedProvider === 'mock') {
    return {
      pricingStatus: 'not_applicable',
      estimatedCostUsd: 0,
      rateSource: 'mock',
      model: normalizedModel || 'mock',
      inputRatePer1MUsd: null,
      outputRatePer1MUsd: null,
      explanation: 'The Mock provider uses local fixtures and makes no model API calls; no API usage charge is incurred.'
    };
  }

  const providerModelRates = findCaseInsensitiveKey(modelCostRates, normalizedProvider) ?? {};
  const exactEntry = normalizedModel ? findCaseInsensitiveKey(providerModelRates, normalizedModel) : undefined;
  const exactRates = normalizeRates(exactEntry);
  const providerRates = normalizeRates(findCaseInsensitiveKey(providerCostRates, normalizedProvider));

  if (exactRates?.complete) {
    return {
      pricingStatus: 'estimated',
      estimatedCostUsd: calculateUsd(safeInputTokens, safeOutputTokens, exactRates.inputPer1MUsd, exactRates.outputPer1MUsd),
      rateSource: 'model-specific',
      model: normalizedModel,
      inputRatePer1MUsd: exactRates.inputPer1MUsd,
      outputRatePer1MUsd: exactRates.outputPer1MUsd,
      explanation: `Estimated with configured model-specific rates for ${normalizedProvider}/${normalizedModel}: input $${exactRates.inputPer1MUsd} and output $${exactRates.outputPer1MUsd} per 1,000,000 tokens. This estimate does not account for cached-token discounts or other provider-specific billing adjustments.`
    };
  }

  if (providerRates?.complete) {
    const detail = exactEntry
      ? `The model-specific entry is incomplete (${formatMissingRates(exactRates)}).`
      : `No complete model-specific rate is configured for ${normalizedProvider}/${normalizedModel || 'unknown model'}.`;
    return {
      pricingStatus: 'estimated',
      estimatedCostUsd: calculateUsd(safeInputTokens, safeOutputTokens, providerRates.inputPer1MUsd, providerRates.outputPer1MUsd),
      rateSource: 'provider-default',
      model: normalizedModel || null,
      inputRatePer1MUsd: providerRates.inputPer1MUsd,
      outputRatePer1MUsd: providerRates.outputPer1MUsd,
      explanation: `${detail} Estimated using provider-wide fallback rates. This may not match the exact model's price and does not account for cached-token discounts or other provider-specific billing adjustments.`
    };
  }

  const missingDetail = exactEntry
    ? `The model-specific rate for ${normalizedProvider}/${normalizedModel} is incomplete (${formatMissingRates(exactRates)}).`
    : `No complete model-specific rate is configured for ${normalizedProvider}/${normalizedModel || 'unknown model'}.`;
  const hasAnyProviderRate = Boolean(providerRates && (providerRates.inputConfigured || providerRates.outputConfigured));
  const fallbackDetail = hasAnyProviderRate
    ? ` Provider-wide fallback rates are also incomplete (${formatMissingRates(providerRates)}).`
    : ` Provider-wide fallback rates are not configured.`;
  const explanation = `Estimated cost unavailable: ${missingDetail}${fallbackDetail} Configure inputPer1MUsd and outputPer1MUsd in MODEL_COST_RATES_JSON, or set both provider-wide rate variables, then run a new evaluation.`;

  return {
    pricingStatus: 'unavailable',
    estimatedCostUsd: null,
    rateSource: null,
    model: normalizedModel || null,
    inputRatePer1MUsd: exactRates?.inputPer1MUsd ?? null,
    outputRatePer1MUsd: exactRates?.outputPer1MUsd ?? null,
    explanation
  };
}
