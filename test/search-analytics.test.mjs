// Comprueba que los filtros, dataState y startRow llegan bien a la API (sin red).
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const entry = resolve(process.env.GSC_TEST_ENTRY || 'build/index.js');
const mock = fileURLToPath(new URL('./google-api-mock.cjs', import.meta.url));

async function withClient(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'gsc-sa-test-'));
  const adcFile = join(dir, 'adc.json');
  await writeFile(adcFile, JSON.stringify({
    type: 'authorized_user', client_id: 'fake-client', client_secret: 'fake-secret',
    refresh_token: 'fake-refresh-token', quota_project_id: 'test-quota-project',
  }));
  const transport = new StdioClientTransport({
    command: process.execPath, args: ['--require', mock, entry], stderr: 'pipe',
    env: { GOOGLE_APPLICATION_CREDENTIALS: '', GSC_TEST_ENTRY: entry, GSC_TEST_AUTH: 'adc', GSC_TEST_ADC_FILE: adcFile },
  });
  const client = new Client({ name: 'gsc-sa-test', version: '1.0.0' });
  try { await client.connect(transport); return await fn(client); }
  finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
}

// El mock devuelve el cuerpo de la petición en la primera columna de la tabla
const sentBody = (result) => JSON.parse(result.content[0].text.split('\n')[5].split(' | ')[0]);

test('por defecto pide datos finales y empieza en la fila 0', { timeout: 15000 }, async () => {
  const body = await withClient(async (c) => sentBody(await c.callTool({ name: 'search_analytics',
    arguments: { siteUrl: 'sc-domain:example.com', startDate: '2026-10-01', endDate: '2026-10-31' } })));
  assert.equal(body.dataState, 'final');
  assert.equal(body.startRow, 0);
  assert.deepEqual(body.dimensions, ['query']);
});

test('excluye consultas de marca con regex y pagina', { timeout: 15000 }, async () => {
  const body = await withClient(async (c) => sentBody(await c.callTool({ name: 'search_analytics',
    arguments: { siteUrl: 'sc-domain:example.com', startDate: '2026-10-01', endDate: '2026-10-31',
      dimensions: 'query,page', excludeQueryFilter: 'regex:idr|consulting', excludePageFilter: '/blog/',
      dataState: 'all', startRow: 25000 } })));
  assert.equal(body.dataState, 'all');
  assert.equal(body.startRow, 25000);
  assert.deepEqual(body.dimensionFilterGroups[0].filters, [
    { dimension: 'query', operator: 'excludingRegex', expression: 'idr|consulting' },
    { dimension: 'page', operator: 'notContains', expression: '/blog/' },
  ]);
});

test('los errores salen marcados como isError', { timeout: 15000 }, async () => {
  const result = await withClient((c) => c.callTool({ name: 'inspect_url',
    arguments: { siteUrl: 'sc-domain:example.com', inspectionUrl: 'https://example.com/' } }));
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /^Error inspecting URL: /);
  assert.ok(result.content[0].text.length <= 330);
});
