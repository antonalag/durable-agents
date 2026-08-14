/**
 * Example: Research Agent with LangGraph.js + durable-agents
 *
 * This shows how you'd add crash-recovery to a LangGraph.js research agent.
 * Each graph "node" maps to a durable step — if the process dies mid-execution,
 * completed steps replay instantly from the journal on restart.
 *
 * Since LangGraph.js is an optional peer dependency, this example uses
 * DurableWorkflow directly. The pattern is identical to what
 * createDurableMiddleware does internally.
 *
 * Run: npx tsx examples/langgraph-research-agent.ts
 */

import { DurableWorkflow, SqliteJournalStore, EventBus } from 'durable-agents';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// In a real LangGraph agent these would call an LLM via @langchain/openai, etc.

async function searchNode(query: string) {
  await sleep(40);
  return {
    results: [
      'Durable execution ensures at-least-once delivery',
      'Outcome journaling records step results for replay',
      'Temporal.io popularized the pattern for microservices',
    ],
    query,
  };
}

async function summarizeNode(results: string[]) {
  await sleep(35);
  return {
    summary: `Synthesized ${results.length} sources on durable execution patterns`,
    keyPoints: [
      'At-least-once delivery via outcome journaling',
      'Step-level replay avoids redundant LLM calls',
    ],
  };
}

async function factCheckNode(summary: string) {
  await sleep(30);
  return { verified: true, confidence: 0.95, checkedClaims: 2 };
}

async function citeSourcesNode(results: string[]) {
  await sleep(25);
  return { citations: results.map((r, i) => `[${i + 1}] ${r}`) };
}

async function compileNode(data: {
  summary: string;
  citations: string[];
  confidence: number;
}) {
  await sleep(45);
  return {
    report: `Research report: ${data.summary} (${data.citations.length} sources, ${(data.confidence * 100).toFixed(0)}% confidence)`,
    wordCount: 850,
  };
}

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'langgraph-research-'));
  const store = new SqliteJournalStore(join(dir, 'journal.db'));
  const eventBus = new EventBus();

  console.log(cyan('\n Research Agent — LangGraph.js + durable-agents\n'));
  console.log(dim('Each LangGraph node becomes a durable step.'));
  console.log(dim('If the process crashes, completed steps replay from the journal.\n'));

  /*
   * With the real peer dependency installed, you'd write:
   *
   *   import { createDurableMiddleware } from 'durable-agents/langgraph';
   *
   *   const { middleware, store } = createDurableMiddleware({
   *     store: new SqliteJournalStore('./journal.db'),
   *   });
   *
   *   const graph = new StateGraph(AgentState)
   *     .addNode('search', searchNode)
   *     .addNode('summarize', summarizeNode)
   *     .addNode('fact_check', factCheckNode)
   *     .addNode('cite_sources', citeSourcesNode)
   *     .addNode('compile', compileNode)
   *     .addEdge('search', 'summarize')
   *     .addConditionalEdges('summarize', parallelRouter, ['fact_check', 'cite_sources'])
   *     .addEdge(['fact_check', 'cite_sources'], 'compile')
   *     .compile({ checkpointer: middleware });
   *
   *   const result = await graph.invoke({ query: 'durable execution patterns' });
   *
   * Below we use DurableWorkflow directly — same recovery semantics, same journal.
   */

  const workflow = new DurableWorkflow(
    'research-agent',
    async (ctx, input: { query: string }) => {
      // Node 1: Search — equivalent to a LangGraph "search" node
      const searchResult = await ctx.step('search', () => searchNode(input.query));
      console.log(
        green('  [ok] search'),
        dim(`— found ${searchResult.results.length} results`),
      );

      // Node 2: Summarize — equivalent to a "summarize" node
      const summary = await ctx.step('summarize', () =>
        summarizeNode(searchResult.results),
      );
      console.log(
        green('  [ok] summarize'),
        dim(`— ${summary.keyPoints.length} key points extracted`),
      );

      // Node 3: Parallel branches — in LangGraph these would be parallel edges
      // Both fact-check and cite-sources run concurrently, both journaled independently
      const [factCheck, citations] = await Promise.all([
        ctx.step('fact-check', () => factCheckNode(summary.summary)),
        ctx.step('cite-sources', () => citeSourcesNode(searchResult.results)),
      ]);
      console.log(
        green('  [ok] fact-check'),
        dim(`— confidence: ${(factCheck.confidence * 100).toFixed(0)}%`),
      );
      console.log(
        green('  [ok] cite-sources'),
        dim(`— ${citations.citations.length} citations`),
      );

      // Node 4: Compile — final aggregation node
      const report = await ctx.step('compile', () =>
        compileNode({
          summary: summary.summary,
          citations: citations.citations,
          confidence: factCheck.confidence,
        }),
      );
      console.log(green('  [ok] compile'), dim(`— ${report.wordCount} words`));

      return report;
    },
    { store, eventBus, heartbeatIntervalMs: 1000, staleTimeoutMs: 5000 },
  );

  // Event hooks — monitor execution lifecycle
  workflow.on('run:started', () => console.log(dim('\n  [event] run:started')));
  workflow.on('step:completed', (e) =>
    console.log(dim(`  [event] step:completed — ${e.nodeName} (${e.durationMs}ms)`)),
  );
  workflow.on('run:completed', (e) =>
    console.log(dim(`  [event] run:completed — ${e.totals.steps} steps total`)),
  );

  // Execute the research workflow
  const result = await workflow.run({ query: 'durable execution patterns' });

  console.log(cyan('\n Research complete!'));
  console.log(`   ${result.report}`);
  console.log(dim(`   Word count: ${result.wordCount}\n`));

  // Cleanup temp storage
  store.close();
  rmSync(dir, { recursive: true });
}

main().catch(console.error);
