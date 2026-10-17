import { env } from '../config/env.js';
import { createLlmProvider, estimateCostDetails } from '../providers/llm-provider.js';
import { gradeCase } from './grading.service.js';
import { validateAgentTrace } from './agent-trace.service.js';
import {
  addAuditEvent,
  getEvaluationById,
  getEvaluationContext,
  getResult,
  markResultStarted,
  saveEvaluationResult,
  updateRunStatus
} from '../repositories/evaluations.repository.js';

function serializeInput(input) {
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

/** True only when the provider returned finite numeric token counts. */
export function usageWasReported(usage) {
  return Boolean(usage) && typeof usage === 'object'
    && Number.isFinite(Number(usage.inputTokens)) && usage.inputTokens !== null && usage.inputTokens !== undefined
    && Number.isFinite(Number(usage.outputTokens)) && usage.outputTokens !== null && usage.outputTokens !== undefined;
}

export async function processEvaluationRun(runId) {
  const context = await getEvaluationContext(runId);
  if (!context) throw new Error(`Evaluation run ${runId} was not found`);
  if (context.run.status === 'cancelled') return;

  let provider;
  try {
    provider = createLlmProvider({ provider: context.run.provider, model: context.run.model });
  } catch (error) {
    for (const testCase of context.cases) {
      const existing = await getResult(runId, testCase.id);
      if (existing && ['passed', 'failed', 'error'].includes(existing.status)) continue;
      await saveEvaluationResult({
        runId,
        testCaseId: testCase.id,
        status: 'error',
        actualOutput: null,
        toolCalls: [],
        graders: [],
        score: null,
        latencyMs: null,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: null,
        errorMessage: error.message,
        failureCategory: 'provider_error',
        errorStage: 'provider_initialization',
        trace: [{ type: 'case.error', at: new Date().toISOString(), stage: 'provider_initialization', message: error.message }]
      });
    }
    await updateRunStatus(runId, 'failed', error.message);
    return;
  }

  await updateRunStatus(runId, 'running');
  // Cancellation may race with provider initialization. Do not begin work or
  // emit a started event if another request already moved the run to a terminal state.
  const startedRun = await getEvaluationById(runId);
  if (!startedRun || startedRun.status !== 'running') return;
  await addAuditEvent(runId, 'evaluation.started', { caseCount: context.cases.length });

  for (const testCase of context.cases) {
    const currentRun = await getEvaluationById(runId);
    if (!currentRun || currentRun.status === 'cancelled') {
      if (currentRun) await addAuditEvent(runId, 'evaluation.stopped', { reason: 'cancelled' });
      return;
    }

    const existing = await getResult(runId, testCase.id);
    if (existing && ['passed', 'failed', 'error'].includes(existing.status)) continue;

    await markResultStarted(runId, testCase.id);
    const startedAt = Date.now();
    const trace = [{ type: 'case.started', at: new Date().toISOString(), testCaseId: testCase.id }];
    let errorStage = 'generation';
    let failureCategory = 'provider_error';

    try {
      const response = await provider.generate({ testCase, systemPrompt: context.run.system_prompt });
      if (!response || typeof response !== 'object') {
        errorStage = 'model_response';
        failureCategory = 'model_failure';
        throw new Error('Provider returned an invalid model response envelope.');
      }
      errorStage = 'grading';
      failureCategory = 'evaluator_error';
      let grade = gradeCase(testCase, response);
      const generationModel = response.providerMetadata?.actualModel
        ?? response.providerMetadata?.modelVersion
        ?? response.providerMetadata?.model
        ?? provider.model
        ?? context.run.model;
      const usageCalls = [{
        operation: 'generation',
        provider: context.run.provider,
        model: generationModel,
        inputTokens: Number(response.usage?.inputTokens ?? 0),
        outputTokens: Number(response.usage?.outputTokens ?? 0),
        usageReported: usageWasReported(response.usage)
      }];
      const judgeConfig = testCase.grading_rules ?? {};
      if (judgeConfig.judgeEnabled === true && typeof provider.judge === 'function') {
        errorStage = 'llm_judge';
        failureCategory = 'provider_error';
        const judgeResult = await provider.judge({
          testCase,
          response,
          systemPrompt: context.run.system_prompt
        });
        // The Mock provider's judge is a local deterministic keyword checker,
        // not a billable LLM request. Only add usage calls for actual model judges.
        if (judgeResult.providerMetadata?.mode !== 'mock') {
          const judgeModel = judgeResult.providerMetadata?.actualModel
            ?? judgeResult.providerMetadata?.modelVersion
            ?? judgeResult.providerMetadata?.model
            ?? generationModel;
          usageCalls.push({
            operation: 'llm_judge',
            provider: context.run.provider,
            model: judgeModel,
            inputTokens: Number(judgeResult.usage?.inputTokens ?? 0),
            outputTokens: Number(judgeResult.usage?.outputTokens ?? 0),
            usageReported: usageWasReported(judgeResult.usage)
          });
        }
        errorStage = 'grading';
        failureCategory = 'evaluator_error';
        grade = {
          ...grade,
          passed: grade.passed && judgeResult.passed,
          score: Number(((grade.score + judgeResult.score) / 2).toFixed(4)),
          graders: [...grade.graders, {
            name: 'llm_judge', passed: judgeResult.passed, score: judgeResult.score,
            details: judgeResult.explanation
          }]
        };
      }
      const inputTokens = usageCalls.reduce((sum, call) => sum + call.inputTokens, 0);
      const outputTokens = usageCalls.reduce((sum, call) => sum + call.outputTokens, 0);
      const latencyMs = Date.now() - startedAt;
      const actualModel = generationModel;
      const costCalls = usageCalls.map((call) => {
        // Never turn "usage not reported" into a real-looking $0. The Mock
        // provider is exempt: it makes no billable calls.
        if (call.usageReported === false && call.provider !== 'mock') {
          return {
            ...call,
            pricingStatus: 'unavailable',
            estimatedCostUsd: null,
            rateSource: null,
            explanation: `Estimated cost unavailable: the provider did not report token usage for this ${call.operation} call, so cost was not recorded as zero.`
          };
        }
        return {
          ...call,
          ...estimateCostDetails({ provider: call.provider, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens })
        };
      });
      const unavailableCostCalls = costCalls.filter((call) => call.pricingStatus === 'unavailable');
      const pricedCostCalls = costCalls.filter((call) =>
        ['estimated', 'not_applicable'].includes(call.pricingStatus)
        && call.estimatedCostUsd !== null && call.estimatedCostUsd !== undefined
      );
      const knownEstimatedCostUsd = pricedCostCalls.length
        ? Number(pricedCostCalls.reduce((sum, call) => sum + Number(call.estimatedCostUsd), 0).toFixed(10))
        : null;
      const estimatedCostUsd = unavailableCostCalls.length ? null : knownEstimatedCostUsd;
      const costSources = [...new Set(costCalls.map((call) => call.rateSource).filter(Boolean))];
      const costEstimate = {
        pricingStatus: unavailableCostCalls.length
          ? (pricedCostCalls.length ? 'partial' : 'unavailable')
          : costCalls.every((call) => call.pricingStatus === 'not_applicable')
            ? 'not_applicable'
            : 'estimated',
        estimatedCostUsd,
        knownEstimatedCostUsd,
        currency: 'USD',
        rateSources: costSources,
        calls: costCalls,
        explanation: unavailableCostCalls.length
          ? `${pricedCostCalls.length ? `Known subtotal: $${knownEstimatedCostUsd.toFixed(8)}; full cost is unavailable. ` : ''}${[...new Set(unavailableCostCalls.map((call) => call.explanation))].join(' ')}`
          : [...new Set(costCalls.map((call) => call.explanation))].join(' ')
      };
      const providerMetadata = { ...(response.providerMetadata ?? {}), costEstimate };
      const agentTraceValidation = response.agentTrace === undefined || response.agentTrace === null
        ? null : validateAgentTrace(response.agentTrace);
      const storedAgentTrace = agentTraceValidation?.success ? agentTraceValidation.data : null;
      trace.push({
        type: 'model.completed', at: new Date().toISOString(), latencyMs,
        provider: provider.name, model: actualModel, requestedModel: providerMetadata.requestedModel ?? provider.model,
        fallbackUsed: providerMetadata.fallbackUsed === true,
        ...(providerMetadata.fallbackReason ? { fallbackReason: providerMetadata.fallbackReason } : {}),
        metadata: providerMetadata
      });
      if (providerMetadata.fallbackUsed === true) {
        await addAuditEvent(runId, 'model.fallback_used', {
          testCaseId: testCase.id, requestedModel: providerMetadata.requestedModel ?? provider.model,
          actualModel, reason: providerMetadata.fallbackReason ?? 'Configured Gemini fallback used.'
        });
      }
      trace.push({ type: 'grading.completed', at: new Date().toISOString(), score: grade.score, passed: grade.passed });
      if (agentTraceValidation && !agentTraceValidation.success) {
        trace.push({ type: 'agent_trace.rejected', at: new Date().toISOString(), message: agentTraceValidation.error });
      }

      errorStage = 'result_persistence';
      failureCategory = 'evaluator_error';
      const hasUsableOutput = (typeof response.content === 'string' && response.content.trim().length > 0)
        || (Array.isArray(response.toolCalls) && response.toolCalls.length > 0);
      await saveEvaluationResult({
        runId, testCaseId: testCase.id, status: grade.passed ? 'passed' : 'failed',
        actualOutput: {
          content: response.content,
          toolCalls: response.toolCalls,
          ...(storedAgentTrace ? { agentTrace: storedAgentTrace } : {}),
          ...(agentTraceValidation && !agentTraceValidation.success
            ? { agentTraceValidation: { valid: false, error: agentTraceValidation.error } } : {}),
          providerMetadata
        },
        toolCalls: response.toolCalls, graders: grade.graders, score: grade.score, latencyMs,
        inputTokens, outputTokens, estimatedCostUsd,
        errorMessage: hasUsableOutput ? null : 'The model returned no usable text or proposed tool calls.',
        failureCategory: hasUsableOutput ? null : 'model_failure',
        errorStage: hasUsableOutput ? null : 'model_response',
        trace
      });
    } catch (error) {
      const latencyMs = Date.now() - startedAt;
      trace.push({ type: 'case.error', at: new Date().toISOString(), message: error.message });
      const isModelFailure = failureCategory === 'model_failure';
      await saveEvaluationResult({
        runId, testCaseId: testCase.id, status: isModelFailure ? 'failed' : 'error', actualOutput: null,
        toolCalls: [],
        graders: isModelFailure ? [{ name: 'model_response', passed: false, score: 0, details: error.message }] : [],
        score: isModelFailure ? 0 : null, latencyMs, inputTokens: 0,
        outputTokens: 0, estimatedCostUsd: null, errorMessage: error.message, failureCategory, errorStage, trace
      });
    }
  }

  const finalRun = await getEvaluationById(runId);
  if (finalRun?.status === 'cancelled') return;
  const completed = await getEvaluationById(runId);
  if (completed && completed.completed_cases < completed.total_cases && completed.error_message) {
    await updateRunStatus(runId, 'failed', completed.error_message);
    return;
  }
  const markedCompleted = await updateRunStatus(runId, 'completed');
  if (markedCompleted) {
    await addAuditEvent(runId, 'evaluation.finished', {
      inputSummary: serializeInput({ completedCases: completed?.completed_cases, totalCases: completed?.total_cases })
    });
  }
}
