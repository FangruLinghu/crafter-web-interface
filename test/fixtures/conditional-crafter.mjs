if (process.env.CRAFTER_MODEL === 'test-timeout') await import('./process-tree.mjs');
else await import('./crafter.mjs');
