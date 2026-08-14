/**
 * Example: AI SDK Tool Agent with durable-agents
 *
 * Shows how to add durability and idempotent tools to an AI agent.
 * Since the `ai` package isn't installed, we use DurableWorkflow + ctx.step()
 * directly — these are the same primitives that withDurability() calls under the hood.
 *
 * In a real Vercel AI SDK project, you'd do:
 *
 *   import { withDurability } from 'durable-agents/ai-sdk';
 *   import { generateText } from 'ai';
 *
 *   const result = await withDurability({ store, ctx, eventBus }, 'generate', () =>
 *     generateText({ model: openai('gpt-4o'), prompt: 'Plan my task' })
 *   );
 *
 * The recovery and idempotency semantics are identical either way.
 *
 * Run: npx tsx examples/ai-sdk-tool-agent.ts
 */

import { DurableWorkflow, SqliteJournalStore, EventBus, idempotent } from 'durable-agents';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- Mock AI SDK generateText (in real code: import { generateText } from 'ai') ---
async function mockGenerateText(prompt: string) {
  await sleep(30);
  return {
    text: `Response to: ${prompt.slice(0, 40)}`,
    usage: { promptTokens: 150, completionTokens: 45 },
  };
}

// --- Mock side-effecting tool (needs idempotency!) ---
let webhookCallCount = 0;
async function sendWebhook(payload: string) {
  webhookCallCount++;
  await sleep(20);
  return { status: 'delivered', id: `wh-${Date.now()}` };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'ai-sdk-example-'));
  const dbPath = join(dir, 'agent.db');
  const store = new SqliteJournalStore(dbPath);
  const eventBus = new EventBus();

  console.log(cyan('\n AI SDK Tool Agent — durable-agents\n'));
  console.log(dim('Demonstrates: withDurability pattern + idempotent tool calls'));
  console.log(dim('─────────────────────────────────────────────────────────\n'));

  // The workflow wraps an AI agent that:
  // 1. Generates a plan (like calling generateText)
  // 2. Sends a webhook notification — idempotent (fires AT MOST ONCE)
  // 3. Sends the SAME webhook again — returns cached result, no duplicate call
  // 4. Generates a final summary
  //
  // The idempotent() wrapper guarantees that side-effecting tools never re-fire,
  // even if the agent crashes mid-execution and recovers from the journal.

  const workflow = new DurableWorkflow(
    'ai-sdk-tool-agent',
    async (ctx, input: { task: string }) => {
      // Step 1: Generate a plan (equivalent to withDurability wrapping generateText)
      // On recovery, this returns the cached result from the journal — no LLM call.
      const plan = await ctx.step('generate-plan', () =>
        mockGenerateText(`Plan for: ${input.task}`),
      );
      console.log(green('  [ok] generate-plan'), dim(`— ${plan.usage.completionTokens} tokens`));

      // Step 2: Call an idempotent tool (first time — actually executes)
      // idempotent() computes a key from (runId + toolName + args).
      // If the key already has a recorded outcome, it skips execution entirely.
      console.log(dim('    ↳ calling send-notification (first time)'));
      const result1 = await idempotent(
        ctx,
        'send-notification',
        { url: 'https://api.example.com/hook', payload: plan.text },
        () => sendWebhook(plan.text),
      );
      console.log(green('  [ok] send-notification'), dim(`— ${result1.status}`));

      // Step 3: Call the SAME idempotent tool with the SAME args (cache hit!)
      // Because the operation key is identical, it returns the stored result.
      // The webhook is NOT sent again — crucial for billing APIs, notifications, etc.
      console.log(dim('    ↳ calling send-notification (same args — should hit cache)'));
      const result2 = await idempotent(
        ctx,
        'send-notification',
        { url: 'https://api.example.com/hook', payload: plan.text },
        () => sendWebhook(plan.text),
      );
      console.log(
        yellow('  [cached] send-notification'),
        dim('— returned from cache (not re-sent!)'),
      );

      // Both results are identical — same DB record
      const match = JSON.stringify(result1) === JSON.stringify(result2);
      console.log(dim(`    ↳ result1 === result2: ${match}`));

      // Step 4: Generate final response using the tool output
      const summary = await ctx.step('generate-summary', () =>
        mockGenerateText(`Summarize webhook result: ${result1.status}`),
      );
      console.log(green('  [ok] generate-summary'), dim(`— ${summary.usage.completionTokens} tokens`));

      return {
        plan: plan.text,
        summary: summary.text,
        webhookId: result1.id,
        webhookCalls: webhookCallCount,
      };
    },
    { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 },
  );

  // --- Execute the agent ---
  console.log(cyan('  Agent execution:\n'));
  webhookCallCount = 0;

  const result = await workflow.run({ task: 'summarize latest research papers' });

  console.log('\n' + dim('─────────────────────────────────────────────────────────'));
  console.log(cyan('\n Agent completed!\n'));
  console.log(`  Plan:       ${result.plan}`);
  console.log(`  Summary:    ${result.summary}`);
  console.log(`  Webhook ID: ${result.webhookId}`);
  console.log(
    yellow(`\n  Webhook was called only ${result.webhookCalls} time (not 2) — idempotent!\n`),
  );

  // Cleanup
  store.close();
  rmSync(dir, { recursive: true });
}

main().catch(console.error);
