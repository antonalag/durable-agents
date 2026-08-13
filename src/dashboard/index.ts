import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import type { JournalStore } from '../stores/interface.js';
import type { EventBus } from '../runtime/event-bus.js';
import type { ExecutionRun } from '../core/types.js';
import { DurableError } from '../errors.js';
import { HTMX_JS } from './htmx-asset.js';
import { createSseHandler } from './sse.js';
import { runsListPage, runsTable } from './views/runs-list.js';
import { runDetailPage } from './views/run-detail.js';
import { errorPage } from './views/error-page.js';

export interface DashboardOptions {
  store: JournalStore;
  port?: number;
  eventBus?: EventBus;
}

export interface DashboardServer {
  port: number;
  close(): Promise<void>;
}

function sortRuns(runs: ExecutionRun[], sort: string): ExecutionRun[] {
  const sorted = [...runs];
  switch (sort) {
    case 'status': return sorted.sort((a, b) => a.status.localeCompare(b.status));
    case 'cost': return sorted.sort((a, b) => b.totals.cost - a.totals.cost);
    case 'steps': return sorted.sort((a, b) => b.totals.steps - a.totals.steps);
    case 'createdAt': return sorted.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    case 'updatedAt': return sorted.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
    default: return sorted;
  }
}

export async function startDashboard(options: DashboardOptions): Promise<DashboardServer> {
  const port = options.port ?? 3100;

  const app = new Hono();

  app.get('/static/htmx.min.js', (c) => {
    return c.body(HTMX_JS, 200, {
      'Content-Type': 'application/javascript',
      'Cache-Control': 'public, max-age=31536000',
    });
  });

  app.get('/', async (c) => {
    const runs = await options.store.listRuns();
    const sort = c.req.query('sort');
    const statusFilter = c.req.query('status');

    let filtered = runs;
    if (statusFilter) {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }
    if (sort) {
      filtered = sortRuns(filtered, sort);
    }

    return c.html(runsListPage(filtered));
  });

  app.get('/runs/:id', async (c) => {
    const id = c.req.param('id');
    const run = await options.store.getRun(id);
    if (!run) {
      return c.html(errorPage(404, `Run "${id}" not found`), 404);
    }
    const steps = await options.store.listSteps(id);
    return c.html(runDetailPage(run, steps));
  });

  app.get('/api/runs', async (c) => {
    const runs = await options.store.listRuns();
    const sort = c.req.query('sort');
    const statusFilter = c.req.query('status');

    let filtered = runs;
    if (statusFilter) {
      filtered = filtered.filter((r) => r.status === statusFilter);
    }
    if (sort) {
      filtered = sortRuns(filtered, sort);
    }

    return c.html(runsTable(filtered));
  });

  app.get('/api/runs/:id/steps', async (c) => {
    const id = c.req.param('id');
    const steps = await options.store.listSteps(id);
    return c.json(steps);
  });

  app.get('/events', createSseHandler(options.eventBus));

  return new Promise<DashboardServer>((resolve, reject) => {
    const server = serve({ fetch: app.fetch, port }, () => {
      console.log(`durable-agents dashboard listening on http://localhost:${port}`);
      resolve({
        port,
        close: () => new Promise<void>((res) => { server.close(() => res()); }),
      });
    });

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new DurableError('DASHBOARD_PORT_IN_USE', `Port ${port} is already in use`));
      } else {
        reject(err);
      }
    });
  });
}
