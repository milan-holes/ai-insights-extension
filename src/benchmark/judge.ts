import type Anthropic from '@anthropic-ai/sdk';
import { BenchmarkTask, JudgeResult } from './types';

const JUDGE_PROMPT = `You are evaluating an AI assistant's response for accuracy and task completion. Respond with valid JSON only.

Task prompt given to the model:
<task>
{{TASK}}
</task>

Ground truth — these facts MUST be present in the response:
<key_facts>
{{KEY_FACTS}}
</key_facts>

These claims are FALSE — flag them as hallucinations if present:
<forbidden_claims>
{{FORBIDDEN}}
</forbidden_claims>

Model response to evaluate:
<response>
{{RESPONSE}}
</response>

Score the response and respond with this exact JSON structure:
{
  "hallucinationScore": <0-10, 0=none, 10=severe fabrication>,
  "taskSuccessScore": <0-10, 0=complete failure, 10=perfect answer>,
  "hallucinatedFacts": [<list any forbidden claims found, or claims that are factually wrong>],
  "missingFacts": [<key facts not mentioned in the response>],
  "reasoning": "<one sentence explaining your scores>"
}`;

export async function judgeResponse(
  client: Anthropic,
  judgeModel: string,
  task: BenchmarkTask,
  response: string,
): Promise<JudgeResult> {
  const prompt = JUDGE_PROMPT
    .replace('{{TASK}}', task.promptTemplate)
    .replace('{{KEY_FACTS}}', task.groundTruth.keyFacts.map((f, i) => `${i + 1}. ${f}`).join('\n'))
    .replace('{{FORBIDDEN}}', task.groundTruth.forbiddenClaims.map((f, i) => `${i + 1}. ${f}`).join('\n'))
    .replace('{{RESPONSE}}', response.slice(0, 3000));

  const msg = await client.messages.create({
    model: judgeModel,
    max_tokens: 512,
    messages: [{ role: 'user', content: prompt }],
  });

  const raw = msg.content.map(b => b.type === 'text' ? b.text : '').join('').trim();
  const jsonStr = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    const parsed = JSON.parse(jsonStr) as JudgeResult;
    return {
      hallucinationScore: clamp(parsed.hallucinationScore ?? 5, 0, 10),
      taskSuccessScore: clamp(parsed.taskSuccessScore ?? 5, 0, 10),
      hallucinatedFacts: parsed.hallucinatedFacts ?? [],
      missingFacts: parsed.missingFacts ?? [],
      reasoning: parsed.reasoning ?? '',
    };
  } catch {
    return {
      hallucinationScore: 5,
      taskSuccessScore: 5,
      hallucinatedFacts: [],
      missingFacts: [],
      reasoning: 'Judge parse error',
    };
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}
